/**
 * POST /v1/auth/github-oidc — GitHub Actions OIDC exchange endpoint.
 *
 * Verifies a GitHub Actions OIDC `id_token` against the GitHub Actions
 * issuer (signature / audience / exp / iat), checks `repository_owner`
 * against `GITHUB_OIDC_ALLOWED_OWNER`, maps the owner to a dovecote
 * `userId` via `resolveUserId({kind:"oidc",...})` (auto-provisioning on
 * first login), then mints a `dvct_*` runtime token via `issueToken`.
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
} from "./contracts/tokens.js";
import {
  KVWriteError,
  type IssueResult,
} from "./auth/api-token.js";
import type { RateLimitResult } from "./auth/rate-limit.js";
import { writeAudit } from "./auth/audit.js";
import { issueTokenFlow } from "./auth/issue-token-flow.js";
import {
  getOidcClockToleranceSec,
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

const GH_ISSUER = "https://token.actions.githubusercontent.com";
const GH_JWKS_URI = "https://token.actions.githubusercontent.com/.well-known/jwks";

/** Server-enforced TTL cap for GitHub Actions tokens (15 minutes). */
const GH_TOKEN_TTL_CAP = 900;

export type GithubOidcServices = {
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
  jwksResolver?: JwksResolver;
};

type GithubOidcVars = { Bindings: Env };

// Module-scoped JWKS cache for the GitHub Actions issuer.
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

export function createAuthGithubOidcApp(services: GithubOidcServices) {
  const app = new Hono<GithubOidcVars>();

  const verify = services.verifyOidcIdToken ?? defaultVerifyOidcIdToken;
  const resolve = services.resolveUserId ?? defaultResolveUserId;
  const resolveJwks = services.jwksResolver ?? defaultJwksResolver;

  app.post("/v1/auth/github-oidc", async (c) => {
    const env = c.env;
    const ctx = c.executionCtx as ExecutionContext;
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";

    // --- 1. Check required env config (fail-closed, before anything else) ---
    const expectedAud = env.GITHUB_OIDC_EXPECTED_AUD;
    const allowedOwner = env.GITHUB_OIDC_ALLOWED_OWNER;
    if (!expectedAud || !allowedOwner) {
      writeAudit(env, ctx, {
        event: "auth.exchange.oidc",
        ok: false,
        reason: "misconfigured",
        authMethod: "oidc",
        ip,
        scope: "",
      });
      return c.json({ error: "misconfigured" }, 503);
    }

    // --- 2. Parse JSON body ---
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

    // --- 3. Build allowList for GitHub Actions OIDC issuer ---
    const allowList: OidcIssuerConfig[] = [
      {
        issuer: GH_ISSUER,
        jwks_uri: GH_JWKS_URI,
        audience: expectedAud,
      },
    ];
    const clockToleranceSec = getOidcClockToleranceSec(env);

    // --- 4. Rate limit (namespace "github-oidc") — BEFORE verify ---
    const rl = await services.checkRateLimit(env.OAUTH_KV, ip, "github-oidc");
    if (!rl.allowed) {
      writeAudit(env, ctx, {
        event: "auth.exchange.oidc",
        ok: false,
        reason: "rate_limited",
        issuer: GH_ISSUER,
        authMethod: "oidc",
        ip,
        scope: "",
      });
      return c.json(
        { error: "rate_limited", error_description: "Too many requests" },
        429,
        { "Retry-After": "60" },
      );
    }

    // --- 5. Verify id_token (real jose verify via jwksResolver) ---
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

    // --- 6. Owner check (AFTER verify, BEFORE issueToken) ---
    const repositoryOwner = outcome.claims.repository_owner;
    if (
      typeof repositoryOwner !== "string" ||
      repositoryOwner.toLowerCase() !== allowedOwner.toLowerCase()
    ) {
      writeAudit(env, ctx, {
        event: "auth.exchange.oidc",
        ok: false,
        reason: "forbidden",
        issuer: outcome.issuer,
        authMethod: "oidc",
        ip,
        scope: "",
      });
      return c.json({ error: "forbidden" }, 403);
    }

    // --- 7. Resolve userId (auto-provision on first login) ---
    let user: AuthenticatedUser | null;
    try {
      user = await resolve(
        { kind: "oidc", issuer: outcome.issuer, subject: repositoryOwner },
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

    // --- 8. Issue token: server-enforced TTL cap = 900s ---
    // Client-supplied expiresIn is ignored/truncated; always use cap.
    const ttlSeconds = GH_TOKEN_TTL_CAP;
    const scopes = ["dovecote:notify"];
    return issueTokenFlow(c, {
      env,
      ctx,
      ip,
      userId: user.userId,
      scopes,
      ttlSeconds,
      authMethod: "oidc",
      auditEvent: "auth.exchange.oidc",
      auditExtras: { issuer: outcome.issuer },
      auditScope: scopes.join(" "),
      successStatus: 201,
      errorMode: "swallow",
      invalidScopeOpts: { auditReason: "invalid_scope" },
      missingPepperOpts: { auditReason: "misconfigured" },
      services: {
        issueToken: services.issueToken,
        // checkRateLimit intentionally omitted — already ran in step 6.
      },
    });
  });

  return app;
}
