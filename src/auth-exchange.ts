import { Hono } from "hono";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import type { OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import type { ExecutionContext, KVNamespace } from "@cloudflare/workers-types";
import type { Env } from "./types.js";
import {
  tokenExchangeRequestSchema,
  expiresInToSeconds,
} from "./contracts/tokens.js";
import {
  issueToken as _issueToken,
  InvalidScopeError,
  MissingPepperError,
  type IssueResult,
} from "./auth/api-token.js";
import {
  checkRateLimit as _checkRateLimit,
  type RateLimitResult,
} from "./auth/rate-limit.js";
import { writeAudit } from "./auth/audit.js";

export type ExchangeServices = {
  issueToken: (
    params: { userId: string; scopes: string[]; label?: string; ttlSeconds?: number },
    env: Env
  ) => Promise<IssueResult>;
  checkRateLimit: (
    kv: KVNamespace,
    ip: string,
    namespace: string
  ) => Promise<RateLimitResult>;
  /**
   * Unwrap an OAuth bearer token to its TokenSummary. Returns null if invalid.
   * Surfaces `{ userId, scopes, expiresAtMs }` — the minimum the exchange handler needs.
   * Injectable so tests don't need a full OAuth provider stub.
   */
  unwrapOAuthToken: (
    token: string,
    env: Env
  ) => Promise<UnwrappedOAuthToken | null>;
};

export interface UnwrappedOAuthToken {
  userId: string;
  scopes: string[];
  /** OAuth token expiresAt — milliseconds since epoch */
  expiresAtMs: number;
}

/**
 * Default unwrapper: calls getOAuthApi(options, env).unwrapToken(token).
 * Reads scopes from `summary.grant.props.scopes` (populated by authorize handler)
 * and falls back to `summary.scope` if props is malformed.
 * Converts OAuth expiresAt (unix seconds) → milliseconds.
 */
export function makeDefaultOAuthUnwrapper(
  options: OAuthProviderOptions<Env>
): (token: string, env: Env) => Promise<UnwrappedOAuthToken | null> {
  return async (token: string, env: Env) => {
    const api = getOAuthApi(options, env as any);
    const summary = await api.unwrapToken<{
      userId?: string;
      scopes?: string[];
      authMethod?: string;
      ip?: string;
    }>(token);
    if (!summary) return null;
    const props = summary.grant?.props ?? ({} as any);
    const userId = props.userId ?? summary.userId;
    const scopes =
      Array.isArray(props.scopes) && props.scopes.length > 0
        ? props.scopes
        : Array.isArray(summary.scope)
          ? summary.scope
          : [];
    // OAuth TokenBase.expiresAt is unix seconds; convert to ms.
    const expiresAtMs =
      typeof summary.expiresAt === "number" ? summary.expiresAt * 1000 : 0;
    return { userId, scopes, expiresAtMs };
  };
}

type ExchangeVars = { Bindings: Env };

/**
 * Build the /v1/auth/exchange sub-app. Designed to be mounted on the root app
 * BEFORE the `/v1/*` bearer middleware, so the OAuth bearer (not `dvct_*`) flows
 * through unimpeded.
 */
export function createAuthExchangeApp(services: ExchangeServices) {
  const app = new Hono<ExchangeVars>();

  app.post("/v1/auth/exchange", async (c) => {
    const env = c.env;
    const ctx = c.executionCtx as ExecutionContext;
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";

    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      writeAudit(env, ctx, {
        event: "token.issue",
        ok: false,
        reason: "missing_authorization",
        authMethod: "oauth",
        ip,
        scope: "",
      });
      return c.json(
        { error: "unauthorized", error_description: "missing_authorization" },
        401
      );
    }
    const token = authHeader.substring(7);

    // Parse body (empty body allowed)
    let rawBody: unknown = {};
    try {
      const text = await c.req.text();
      if (text.length > 0) {
        rawBody = JSON.parse(text);
      }
    } catch {
      return c.json(
        { error: "invalid_request", error_description: "Invalid JSON body" },
        400
      );
    }
    const parsed = tokenExchangeRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message || "Invalid request";
      return c.json(
        { error: "invalid_request", error_description: msg },
        400
      );
    }
    const body = parsed.data;

    // Validate the OAuth bearer
    let unwrapped: UnwrappedOAuthToken | null;
    try {
      unwrapped = await services.unwrapOAuthToken(token, env);
    } catch {
      return c.json(
        { error: "unauthorized", error_description: "invalid_token" },
        401
      );
    }
    if (!unwrapped) {
      writeAudit(env, ctx, {
        event: "token.issue",
        ok: false,
        reason: "invalid_token",
        authMethod: "oauth",
        ip,
        scope: "",
      });
      return c.json(
        { error: "unauthorized", error_description: "invalid_token" },
        401
      );
    }
    if (unwrapped.expiresAtMs > 0 && unwrapped.expiresAtMs <= Date.now()) {
      writeAudit(env, ctx, {
        event: "token.issue",
        ok: false,
        reason: "expired_token",
        userId: unwrapped.userId,
        authMethod: "oauth",
        ip,
        scope: unwrapped.scopes.join(" "),
      });
      return c.json(
        { error: "unauthorized", error_description: "expired_token" },
        401
      );
    }
    if (!unwrapped.scopes.includes("dovecote:admin")) {
      writeAudit(env, ctx, {
        event: "token.issue",
        ok: false,
        reason: "forbidden",
        userId: unwrapped.userId,
        authMethod: "oauth",
        ip,
        scope: unwrapped.scopes.join(" "),
      });
      return c.json(
        { error: "forbidden", error_description: "Missing scope: dovecote:admin" },
        403
      );
    }

    // Rate limit (namespace "tokens")
    const rl = await services.checkRateLimit(env.OAUTH_KV, ip, "tokens");
    if (!rl.allowed) {
      writeAudit(env, ctx, {
        event: "token.issue",
        ok: false,
        reason: "rate_limited",
        userId: unwrapped.userId,
        authMethod: "oauth",
        ip,
        scope: unwrapped.scopes.join(" "),
      });
      return c.json(
        { error: "rate_limited", error_description: "Too many requests" },
        429,
        { "Retry-After": "60" }
      );
    }

    try {
      const ttlSeconds = body.expiresIn ? expiresInToSeconds(body.expiresIn) : undefined;
      const result = await services.issueToken(
        {
          userId: unwrapped.userId,
          scopes: unwrapped.scopes,
          label: body.label,
          ttlSeconds,
        },
        env
      );
      writeAudit(env, ctx, {
        event: "token.issue",
        ok: true,
        userId: unwrapped.userId,
        tokenId: result.tokenId,
        scopes: unwrapped.scopes,
        authMethod: "oauth",
        ip,
        scope: unwrapped.scopes.join(" "),
      });
      return c.json(
        {
          token: result.token,
          tokenId: result.tokenId,
          userId: unwrapped.userId,
          scopes: unwrapped.scopes,
          expiresAt: result.expiresAt,
          ...(body.label ? { label: body.label } : {}),
        },
        201
      );
    } catch (err) {
      if (err instanceof InvalidScopeError) {
        return c.json(
          { error: "invalid_request", error_description: err.message },
          400
        );
      }
      if (err instanceof MissingPepperError) {
        return c.json(
          { error: "misconfigured", error_description: "HMAC_PEPPER not configured" },
          503
        );
      }
      writeAudit(env, ctx, {
        event: "token.issue",
        ok: false,
        reason: "internal_error",
        userId: unwrapped.userId,
        authMethod: "oauth",
        ip,
        scope: unwrapped.scopes.join(" "),
      });
      return c.json(
        { error: "internal_error", error_description: "internal error" },
        500
      );
    }
  });

  return app;
}
