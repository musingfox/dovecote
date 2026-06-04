/**
 * OIDC RP callback endpoint: GET /oidc/callback
 *
 * Receives the authorization code + signed state from the upstream IdP,
 * exchanges the code for an id_token, verifies it, checks nonce binding,
 * resolves the dovecote userId, then calls completeAuthorization and 302s
 * to the original client.
 *
 * All rejection paths return 4xx/5xx and MUST NOT call completeAuthorization.
 */

import { Hono } from "hono";
import type { OAuthHelpers, AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../types.js";
import { decodeOidcState } from "./oidc-rp-state.js";
import type { OidcVerifyOutcome } from "./oidc-verify.js";
import type { ResolveUserInput } from "./resolve-user.js";
import {
  verifyOidcIdToken as defaultVerifyOidcIdToken,
} from "./oidc-verify.js";
import { resolveUserId as defaultResolveUserId } from "./resolve-user.js";
import {
  parseOidcIssuers as defaultParseOidcIssuers,
  getOidcClockToleranceSec,
} from "./oidc-config.js";
import type { OidcIssuerConfig } from "./oidc-config.js";
import * as jose from "jose";

// ---------------------------------------------------------------------------
// Env extension (callback needs OAUTH_PROVIDER)
// ---------------------------------------------------------------------------

interface CallbackEnv extends Env {
  OAUTH_PROVIDER: OAuthHelpers;
}

// ---------------------------------------------------------------------------
// Services injection seam
// ---------------------------------------------------------------------------

export type OidcRpCallbackServices = {
  /** Exchange upstream authorization code for token set */
  exchangeUpstreamCode: (input: {
    code: string;
    redirectUri: string;
    env: Env;
  }) => Promise<{ id_token: string } | { error: string }>;

  /** Verify an id_token (same seam as ExchangeOidcServices.verifyOidcIdToken) */
  verifyOidcIdToken: (input: {
    idToken: string;
    allowList: OidcIssuerConfig[];
    clockToleranceSec: number;
    jwksResolver: (cfg: OidcIssuerConfig) => jose.JWTVerifyGetKey;
  }) => Promise<OidcVerifyOutcome>;

  /** Map verified subject to dovecote userId + scopes */
  resolveUserId: (
    input: ResolveUserInput,
    env: Env,
  ) => Promise<{ userId: string; scopes: string[] } | null>;

  /** Parse issuer allow-list from env (optional override) */
  parseOidcIssuers?: (env: Env) => OidcIssuerConfig[];

  /** Return the secret used to sign/verify state tokens */
  stateSecret?: (env: Env) => string;
};

// ---------------------------------------------------------------------------
// Module-level JWKS cache (mirrors auth-exchange-oidc.ts pattern)
// ---------------------------------------------------------------------------

const jwksCache = new Map<string, jose.JWTVerifyGetKey>();

function defaultJwksResolver(cfg: OidcIssuerConfig): jose.JWTVerifyGetKey {
  let cached = jwksCache.get(cfg.jwks_uri);
  if (!cached) {
    cached = jose.createRemoteJWKSet(new URL(cfg.jwks_uri));
    jwksCache.set(cfg.jwks_uri, cached);
  }
  return cached;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOidcRpCallbackApp(
  services: OidcRpCallbackServices,
): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  const verify = services.verifyOidcIdToken ?? defaultVerifyOidcIdToken;
  const resolve = services.resolveUserId ?? defaultResolveUserId;
  const parseIssuers = services.parseOidcIssuers ?? defaultParseOidcIssuers;

  function getStateSecret(env: Env): string {
    if (services.stateSecret) {
      return services.stateSecret(env);
    }
    // Default: use COOKIE_ENCRYPTION_KEY (already present in Env)
    return env.COOKIE_ENCRYPTION_KEY ?? env.HMAC_PEPPER ?? "";
  }

  app.get("/oidc/callback", async (c) => {
    const env = c.env as CallbackEnv;

    // Guard: OAUTH_PROVIDER must be injected (production: library injects it;
    // test: mock provides it).  Without it we cannot complete authorization.
    if (!env.OAUTH_PROVIDER) {
      return c.json(
        { error: "misconfigured", error_description: "OAUTH_PROVIDER not available" },
        500,
      );
    }

    const code = c.req.query("code");
    const stateToken = c.req.query("state");

    // --- 1. Validate presence of state ---
    if (!stateToken) {
      return c.json(
        { error: "invalid_request", error_description: "Missing state parameter" },
        400,
      );
    }

    // --- 2. Decode + verify signed state ---
    const secret = getStateSecret(env);
    const decodedState = await decodeOidcState(stateToken, secret);
    if (!decodedState) {
      return c.json(
        { error: "invalid_request", error_description: "Invalid or tampered state" },
        400,
      );
    }

    // --- 3. Validate presence of code ---
    if (!code) {
      return c.json(
        { error: "invalid_request", error_description: "Missing code parameter" },
        400,
      );
    }

    // --- 4. Exchange code for id_token ---
    const tokenResult = await services.exchangeUpstreamCode({
      code,
      redirectUri: decodedState.redirectUri,
      env,
    });

    if ("error" in tokenResult) {
      return c.json(
        { error: "upstream_error", error_description: tokenResult.error },
        502,
      );
    }

    const { id_token } = tokenResult;

    // --- 5. Verify id_token ---
    let allowList: OidcIssuerConfig[];
    try {
      allowList = parseIssuers(env);
    } catch {
      return c.json(
        { error: "misconfigured", error_description: "OIDC_ISSUERS not configured" },
        503,
      );
    }

    const clockToleranceSec = getOidcClockToleranceSec(env);
    const outcome = await verify({
      idToken: id_token,
      allowList,
      clockToleranceSec,
      jwksResolver: defaultJwksResolver,
    });

    if (outcome.kind !== "ok") {
      return c.json(
        { error: "unauthorized", error_description: outcome.kind },
        401,
      );
    }

    // --- 6. E8: nonce binding — compare id_token nonce vs state nonce ---
    const idTokenNonce = outcome.claims.nonce;
    if (
      typeof idTokenNonce !== "string" ||
      idTokenNonce !== decodedState.nonce
    ) {
      return c.json(
        { error: "unauthorized", error_description: "nonce_mismatch" },
        401,
      );
    }

    // --- 7. Resolve userId ---
    const user = await resolve(
      { kind: "oidc", issuer: outcome.issuer, subject: outcome.subClaim },
      env,
    );

    if (!user) {
      return c.json(
        { error: "unauthorized", error_description: "untrusted_subject" },
        401,
      );
    }

    // --- 8. Reconstruct the AuthRequest from decoded state ---
    const authRequest: AuthRequest = {
      responseType: decodedState.responseType,
      clientId: decodedState.clientId,
      redirectUri: decodedState.redirectUri,
      state: decodedState.state,
      scope: decodedState.scope,
      ...(decodedState.codeChallenge !== undefined
        ? { codeChallenge: decodedState.codeChallenge }
        : {}),
      ...(decodedState.codeChallengeMethod !== undefined
        ? { codeChallengeMethod: decodedState.codeChallengeMethod }
        : {}),
    };

    // --- 9. Complete authorization → 302 ---
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: authRequest,
      userId: user.userId,
      scope: user.scopes,
      metadata: { label: user.userId },
      props: {
        userId: user.userId,
        scopes: user.scopes,
      },
    });

    return c.redirect(redirectTo, 302);
  });

  return app;
}
