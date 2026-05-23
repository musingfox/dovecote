/**
 * POST /v1/auth/exchange-oidc — Phase 4.3 OIDC carve-out endpoint.
 *
 * Verifies an OIDC `id_token` against an allow-listed issuer (signature /
 * audience / exp / iat), maps the subject claim to a dovecote `userId` via
 * `resolveUserId({kind:"oidc",...})` (auto-provisioning on first login),
 * then mints a `dvct_*` runtime token via `issueToken`.
 *
 * Mounted on the root app BEFORE `app.use("/v1/*", bearerMiddleware)` so an
 * unauthenticated POST is NOT rejected by the bearer middleware (ADR 0001
 * carve-out — see `src/index.ts`).
 */

import { Hono } from "hono";
import type { ExecutionContext, KVNamespace } from "@cloudflare/workers-types";
import type { Env } from "./types.js";
import {
  tokenExchangeOidcRequestSchema,
  expiresInToSeconds,
} from "./contracts/tokens.js";
import {
  InvalidScopeError,
  KVWriteError,
  MissingPepperError,
  type IssueResult,
} from "./auth/api-token.js";
import type { RateLimitResult } from "./auth/rate-limit.js";
import { writeAudit } from "./auth/audit.js";
import {
  parseOidcIssuers as defaultParseOidcIssuers,
  getOidcClockToleranceSec,
  OidcConfigError,
  type OidcIssuerConfig,
} from "./auth/oidc-config.js";
import {
  verifyOidcIdToken as defaultVerifyOidcIdToken,
  type OidcVerifyOutcome,
  type JwksResolver,
} from "./auth/oidc-verify.js";
import { resolveUserId as defaultResolveUserId } from "./auth/resolve-user.js";
import type { AuthenticatedUser } from "./auth/authenticate.js";
import * as jose from "jose";

export type ExchangeOidcServices = {
  issueToken: (
    params: { userId: string; scopes: string[]; label?: string; ttlSeconds?: number },
    env: Env,
  ) => Promise<IssueResult>;
  checkRateLimit: (
    kv: KVNamespace,
    ip: string,
    namespace: string,
  ) => Promise<RateLimitResult>;
  verifyOidcIdToken?: typeof defaultVerifyOidcIdToken;
  resolveUserId?: typeof defaultResolveUserId;
  parseOidcIssuers?: typeof defaultParseOidcIssuers;
  jwksResolver?: JwksResolver;
};

type ExchangeOidcVars = { Bindings: Env };

// Module-scoped JWKS cache. Key by `jwks_uri` so multiple issuer configs
// pointing at the same JWKS endpoint share the underlying remote-set.
const jwksCache = new Map<string, jose.JWTVerifyGetKey>();

function defaultJwksResolver(cfg: OidcIssuerConfig): jose.JWTVerifyGetKey {
  let cached = jwksCache.get(cfg.jwks_uri);
  if (!cached) {
    cached = jose.createRemoteJWKSet(new URL(cfg.jwks_uri));
    jwksCache.set(cfg.jwks_uri, cached);
  }
  return cached;
}

const VERIFY_OUTCOME_TO_REASON: Record<
  Exclude<OidcVerifyOutcome["kind"], "ok">,
  string
> = {
  untrusted_issuer: "untrusted_issuer",
  bad_signature: "bad_signature",
  bad_audience: "bad_audience",
  expired_token: "expired_token",
  iat_skew: "iat_skew",
  malformed_token: "malformed_token",
};

export function createAuthExchangeOidcApp(services: ExchangeOidcServices) {
  const app = new Hono<ExchangeOidcVars>();

  const verify = services.verifyOidcIdToken ?? defaultVerifyOidcIdToken;
  const resolve = services.resolveUserId ?? defaultResolveUserId;
  const parseIssuers = services.parseOidcIssuers ?? defaultParseOidcIssuers;
  const resolveJwks = services.jwksResolver ?? defaultJwksResolver;

  app.post("/v1/auth/exchange-oidc", async (c) => {
    const env = c.env;
    const ctx = c.executionCtx as ExecutionContext;
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";

    // --- 1. Parse JSON body ---
    let rawBody: unknown = {};
    try {
      const text = await c.req.text();
      if (text.length > 0) {
        rawBody = JSON.parse(text);
      }
    } catch {
      writeAudit(env, ctx, {
        event: "auth.exchange.oidc",
        ok: false,
        reason: "invalid_request",
        authMethod: "oidc",
        ip,
        scope: "",
      });
      return c.json(
        { error: "invalid_request", error_description: "Invalid JSON body" },
        400,
      );
    }
    const parsed = tokenExchangeOidcRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Invalid request";
      // Mention the failing path so callers can disambiguate (esp. id_token).
      const path = parsed.error.issues[0]?.path?.join(".") ?? "";
      const desc = path ? `${path}: ${msg}` : msg;
      writeAudit(env, ctx, {
        event: "auth.exchange.oidc",
        ok: false,
        reason: "invalid_request",
        authMethod: "oidc",
        ip,
        scope: "",
      });
      return c.json(
        { error: "invalid_request", error_description: desc },
        400,
      );
    }
    const body = parsed.data;

    // --- 2. Load OIDC issuer allow-list ---
    let allowList: OidcIssuerConfig[];
    try {
      allowList = parseIssuers(env);
    } catch (e) {
      if (e instanceof OidcConfigError) {
        writeAudit(env, ctx, {
          event: "auth.exchange.oidc",
          ok: false,
          reason: "misconfigured",
          authMethod: "oidc",
          ip,
          scope: "",
        });
        return c.json(
          {
            error: "misconfigured",
            error_description: "OIDC_ISSUERS not configured",
          },
          503,
        );
      }
      throw e;
    }
    const clockToleranceSec = getOidcClockToleranceSec(env);

    // --- 3. Verify id_token ---
    const outcome = await verify({
      idToken: body.id_token,
      allowList,
      clockToleranceSec,
      jwksResolver: resolveJwks,
    });
    if (outcome.kind !== "ok") {
      const reason = VERIFY_OUTCOME_TO_REASON[outcome.kind];
      writeAudit(env, ctx, {
        event: "auth.exchange.oidc",
        ok: false,
        reason,
        authMethod: "oidc",
        ip,
        scope: "",
      });
      return c.json(
        { error: "unauthorized", error_description: reason },
        401,
      );
    }

    // --- 4. Resolve userId (auto-provision on first login) ---
    let user: AuthenticatedUser | null;
    try {
      user = await resolve(
        { kind: "oidc", issuer: outcome.issuer, subject: outcome.subClaim },
        env,
      );
    } catch (e) {
      if (e instanceof KVWriteError) {
        writeAudit(env, ctx, {
          event: "auth.exchange.oidc",
          ok: false,
          reason: "internal_error",
          issuer: outcome.issuer,
          authMethod: "oidc",
          ip,
          scope: "",
        });
        return c.json(
          { error: "internal_error", error_description: "Failed to persist user record" },
          500,
        );
      }
      throw e;
    }
    if (!user) {
      writeAudit(env, ctx, {
        event: "auth.exchange.oidc",
        ok: false,
        reason: "untrusted_subject",
        issuer: outcome.issuer,
        authMethod: "oidc",
        ip,
        scope: "",
      });
      return c.json(
        { error: "unauthorized", error_description: "untrusted_subject" },
        401,
      );
    }

    // --- 5. Rate limit (namespace "oidc") ---
    const rl = await services.checkRateLimit(env.OAUTH_KV, ip, "oidc");
    if (!rl.allowed) {
      writeAudit(env, ctx, {
        event: "auth.exchange.oidc",
        ok: false,
        reason: "rate_limited",
        userId: user.userId,
        issuer: outcome.issuer,
        authMethod: "oidc",
        ip,
        scope: user.scopes.join(" "),
      });
      return c.json(
        { error: "rate_limited", error_description: "Too many requests" },
        429,
        { "Retry-After": "60" },
      );
    }

    // --- 6. Issue token ---
    try {
      const ttlSeconds = body.expiresIn
        ? expiresInToSeconds(body.expiresIn)
        : undefined;
      const result = await services.issueToken(
        {
          userId: user.userId,
          scopes: user.scopes,
          label: body.label,
          ttlSeconds,
        },
        env,
      );
      writeAudit(env, ctx, {
        event: "auth.exchange.oidc",
        ok: true,
        userId: user.userId,
        tokenId: result.tokenId,
        issuer: outcome.issuer,
        authMethod: "oidc",
        ip,
        scope: user.scopes.join(" "),
      });
      return c.json(
        {
          token: result.token,
          tokenId: result.tokenId,
          userId: user.userId,
          scopes: user.scopes,
          expiresAt: result.expiresAt,
          ...(body.label ? { label: body.label } : {}),
        },
        201,
      );
    } catch (err) {
      if (err instanceof InvalidScopeError) {
        writeAudit(env, ctx, {
          event: "auth.exchange.oidc",
          ok: false,
          reason: "invalid_scope",
          userId: user.userId,
          issuer: outcome.issuer,
          authMethod: "oidc",
          ip,
          scope: user.scopes.join(" "),
        });
        return c.json(
          { error: "invalid_request", error_description: err.message },
          400,
        );
      }
      if (err instanceof MissingPepperError) {
        writeAudit(env, ctx, {
          event: "auth.exchange.oidc",
          ok: false,
          reason: "misconfigured",
          userId: user.userId,
          issuer: outcome.issuer,
          authMethod: "oidc",
          ip,
          scope: user.scopes.join(" "),
        });
        return c.json(
          {
            error: "misconfigured",
            error_description: "HMAC_PEPPER not configured",
          },
          503,
        );
      }
      writeAudit(env, ctx, {
        event: "auth.exchange.oidc",
        ok: false,
        reason: "internal_error",
        userId: user.userId,
        issuer: outcome.issuer,
        authMethod: "oidc",
        ip,
        scope: user.scopes.join(" "),
      });
      return c.json(
        { error: "internal_error", error_description: "internal error" },
        500,
      );
    }
  });

  return app;
}
