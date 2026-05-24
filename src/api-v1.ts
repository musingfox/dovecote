import { Hono } from "hono";
import type { Env } from "./types.js";
import type { AuthCtx } from "./auth/ctx.js";
import type { ExecutionContext, KVNamespace } from "@cloudflare/workers-types";
import type { MessageContent } from "./channels/types.js";
import { sendNotification as _sendNotification } from "./services/notifications.js";
import { listChannels as _listChannels } from "./services/channels.js";
import { readEnv as _readEnv } from "./services/env.js";
import { ScopeError, NotFoundError, UpstreamError } from "./services/errors.js";
import { messageContentSchema } from "./contracts/notifications.js";
import { profileNameSchema } from "./contracts/env.js";
import {
  tokenIssueRequestSchema,
  tokenRenewRequestSchema,
  expiresInToSeconds,
} from "./contracts/tokens.js";
import {
  issueToken as _issueToken,
  revokeToken as _revokeToken,
  getTokenMetadataByTokenId as _getTokenMetadataByTokenId,
  deleteTokenEntries as _deleteTokenEntries,
  listUserTokens as _listUserTokens,
  listAllTokens as _listAllTokens,
  InvalidScopeError,
  MissingPepperError,
  KVWriteError,
  type IssueResult,
  type RevokeResult,
  type TokenMetadata as ApiTokenMetadata,
  type TokenListResult,
} from "./auth/api-token.js";
import { checkRateLimit as _checkRateLimit, type RateLimitResult } from "./auth/rate-limit.js";
import { writeAudit } from "./auth/audit.js";
import type { SendResult, ChannelConfig } from "./types.js";

type V1Vars = { Bindings: Env; Variables: { auth: AuthCtx } };

export type V1Services = {
  sendNotification: (
    env: Env,
    auth: AuthCtx,
    ctx: ExecutionContext,
    args: { channel: string; content: MessageContent }
  ) => Promise<SendResult>;
  listChannels: (env: Env, auth: AuthCtx) => ChannelConfig[];
  readEnv: (
    env: Env,
    auth: AuthCtx,
    ctx: ExecutionContext,
    args: { profile: string }
  ) => Promise<string>;
  issueToken: (
    params: { userId: string; scopes: string[]; label?: string; ttlSeconds?: number },
    env: Env
  ) => Promise<IssueResult>;
  revokeToken: (
    params: { tokenId: string; env: Env },
    env: Env
  ) => Promise<RevokeResult>;
  checkRateLimit: (
    kv: KVNamespace,
    ip: string,
    namespace: string,
    limit?: number
  ) => Promise<RateLimitResult>;
  getTokenMetadataByTokenId?: (
    tokenId: string,
    env: Env
  ) => Promise<ApiTokenMetadata | null>;
  deleteTokenEntries?: (
    meta: ApiTokenMetadata,
    env: Env
  ) => Promise<void>;
  // Optional list helpers; default-wired below. Surfaced as service slots so
  // tests can inject stubs without populating MockKV with thousands of keys.
  listUserTokens?: (userId: string, env: Env) => Promise<TokenListResult>;
  listAllTokens?: (env: Env) => Promise<TokenListResult>;
};

// Error mapping helper
function parseNotifyLimit(value?: string): number {
  if (value === undefined) return 60;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 60;
}

function mapError(c: any, err: unknown): Response {
  if (err instanceof ScopeError) {
    return c.json({ error: "forbidden", error_description: err.message }, 403);
  }
  if (err instanceof NotFoundError) {
    return c.json({ error: "not_found", error_description: err.message }, 404);
  }
  if (err instanceof UpstreamError) {
    return c.json({ error: "upstream_error", error_description: err.message }, 502);
  }
  return c.json({ error: "internal_error", error_description: "internal error" }, 500);
}

/**
 * Build the /v1 router with injected service implementations.
 * Production code uses createV1App() (default-wired). Tests pass mocks.
 */
export function createV1App(services: V1Services) {
  const v1 = new Hono<V1Vars>();

  // POST /v1/notify
  v1.post("/notify", async (c) => {
    const auth = c.get("auth");
    const env = c.env;
    const ctx = c.executionCtx as ExecutionContext;
    const ip = auth.ip;
    const scope = auth.scopes.join(" ");

    const rl = await services.checkRateLimit(
      env.OAUTH_KV,
      ip,
      "notify",
      parseNotifyLimit(env.NOTIFY_RATE_LIMIT_PER_MINUTE)
    );
    if (!rl.allowed) {
      writeAudit(env, ctx, {
        event: "notify.send",
        ok: false,
        reason: "rate_limited",
        userId: auth.userId,
        authMethod: auth.authMethod,
        ip,
        scope,
      });
      return c.json(
        { error: "rate_limited", error_description: "Too many requests" },
        429,
        { "Retry-After": "60" }
      );
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_request", error_description: "Invalid JSON" }, 400);
    }

    const result = messageContentSchema.safeParse(body.content);
    if (!result.success) {
      const errorMessage = result.error.issues[0]?.message || "Invalid request";
      return c.json(
        { error: "invalid_request", error_description: errorMessage },
        400
      );
    }

    if (typeof body.channel !== "string") {
      return c.json(
        { error: "invalid_request", error_description: "channel must be a string" },
        400
      );
    }

    try {
      const sendResult: SendResult = await services.sendNotification(env, auth, ctx!, {
        channel: body.channel,
        content: body.content,
      });

      if (!sendResult.success) {
        const errorDescription = sendResult.error || "Unknown channel";
        return c.json(
          { error: "not_found", error_description: errorDescription },
          404
        );
      }

      return c.json(sendResult);
    } catch (err) {
      return mapError(c, err);
    }
  });

  // GET /v1/channels
  v1.get("/channels", async (c) => {
    const auth = c.get("auth");
    const env = c.env;

    try {
      const channels = services.listChannels(env, auth);
      return c.json({ channels });
    } catch (err) {
      return mapError(c, err);
    }
  });

  // GET /v1/env/:profile
  v1.get("/env/:profile", async (c) => {
    const auth = c.get("auth");
    const env = c.env;
    const ctx = c.executionCtx;

    const profile = c.req.param("profile");

    const result = profileNameSchema.safeParse(profile);
    if (!result.success) {
      const errorMessage = result.error.issues[0]?.message || "Invalid request";
      return c.json(
        { error: "invalid_request", error_description: errorMessage },
        400
      );
    }

    try {
      const value = await services.readEnv(env, auth, ctx!, { profile });
      return c.json({ profile, value });
    } catch (err) {
      return mapError(c, err);
    }
  });

  // GET /v1/tokens — self-list + admin-list (Phase 4.3 / C-Endpoint-ListSelf+ListAdmin)
  v1.get("/tokens", async (c) => {
    const auth = c.get("auth");
    const env = c.env;
    const ctx = c.executionCtx as ExecutionContext;
    const ip = auth.ip;
    const scopeStr = auth.scopes.join(" ");

    const userIdFilter = c.req.query("userId");
    const isAdmin = auth.scopes.includes("dovecote:admin");

    // Non-admin: refuse to list another user's tokens (loud 403, not silent ignore)
    if (userIdFilter && !isAdmin && userIdFilter !== auth.userId) {
      writeAudit(env, ctx, {
        event: "token.list",
        ok: false,
        reason: "forbidden",
        userIdFilter,
        authMethod: auth.authMethod,
        ip,
        scope: scopeStr,
      });
      return c.json(
        {
          error: "forbidden",
          error_description:
            "Cannot list tokens of another user without dovecote:admin",
        },
        403
      );
    }

    // Rate limit (shared "tokens" namespace with issue/revoke/renew).
    const rl = await services.checkRateLimit(env.OAUTH_KV, ip, "tokens");
    if (!rl.allowed) {
      writeAudit(env, ctx, {
        event: "token.list",
        ok: false,
        reason: "rate_limited",
        ...(userIdFilter ? { userIdFilter } : {}),
        authMethod: auth.authMethod,
        ip,
        scope: scopeStr,
      });
      return c.json(
        { error: "rate_limited", error_description: "Too many requests" },
        429,
        { "Retry-After": "60" }
      );
    }

    try {
      const listUserFn = services.listUserTokens ?? _listUserTokens;
      const listAllFn = services.listAllTokens ?? _listAllTokens;
      let result: TokenListResult;
      if (userIdFilter) {
        result = await listUserFn(userIdFilter, env);
      } else if (isAdmin) {
        result = await listAllFn(env);
      } else {
        result = await listUserFn(auth.userId, env);
      }

      writeAudit(env, ctx, {
        event: "token.list",
        ok: true,
        count: result.tokens.length,
        truncated: result.truncated,
        ...(userIdFilter ? { userIdFilter } : {}),
        authMethod: auth.authMethod,
        ip,
        scope: scopeStr,
      });

      return c.json(
        { tokens: result.tokens, truncated: result.truncated },
        200
      );
    } catch (_err) {
      writeAudit(env, ctx, {
        event: "token.list",
        ok: false,
        reason: "internal_error",
        ...(userIdFilter ? { userIdFilter } : {}),
        authMethod: auth.authMethod,
        ip,
        scope: scopeStr,
      });
      return c.json(
        { error: "internal_error", error_description: "internal error" },
        500
      );
    }
  });

  // POST /v1/tokens — admin-gated token issuance (C2.5.a)
  v1.post("/tokens", async (c) => {
    const auth = c.get("auth");
    const env = c.env;
    const ctx = c.executionCtx as ExecutionContext;
    const ip = auth.ip;
    const scope = auth.scopes.join(" ");

    // Admin gate
    if (!auth.scopes.includes("dovecote:admin")) {
      writeAudit(env, ctx, {
        event: "token.issue",
        ok: false,
        reason: "forbidden",
        authMethod: auth.authMethod,
        ip,
        scope,
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
        authMethod: auth.authMethod,
        ip,
        scope,
      });
      return c.json(
        { error: "rate_limited", error_description: "Too many requests" },
        429,
        { "Retry-After": "60" }
      );
    }

    // Parse and validate body
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      writeAudit(env, ctx, {
        event: "token.issue",
        ok: false,
        reason: "invalid_json",
        authMethod: auth.authMethod,
        ip,
        scope,
      });
      return c.json(
        { error: "invalid_request", error_description: "Invalid JSON body" },
        400
      );
    }
    const parsed = tokenIssueRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      writeAudit(env, ctx, {
        event: "token.issue",
        ok: false,
        reason: "invalid_request",
        authMethod: auth.authMethod,
        ip,
        scope,
      });
      const msg = parsed.error.issues[0]?.message || "Invalid request";
      return c.json({ error: "invalid_request", error_description: msg }, 400);
    }
    const body = parsed.data;

    try {
      const ttlSeconds = body.expiresIn ? expiresInToSeconds(body.expiresIn) : undefined;
      const result = await services.issueToken(
        { userId: body.userId, scopes: body.scopes, label: body.label, ttlSeconds },
        env
      );
      writeAudit(env, ctx, {
        event: "token.issue",
        ok: true,
        userId: body.userId,
        tokenId: result.tokenId,
        scopes: body.scopes,
        authMethod: auth.authMethod,
        ip,
        scope,
      });
      return c.json(
        {
          token: result.token,
          tokenId: result.tokenId,
          userId: body.userId,
          scopes: body.scopes,
          expiresAt: result.expiresAt,
          ...(body.label ? { label: body.label } : {}),
        },
        201
      );
    } catch (err) {
      if (err instanceof InvalidScopeError) {
        writeAudit(env, ctx, {
          event: "token.issue",
          ok: false,
          reason: "invalid_scope",
          userId: body.userId,
          authMethod: auth.authMethod,
          ip,
          scope,
        });
        return c.json(
          { error: "invalid_request", error_description: err.message },
          400
        );
      }
      if (err instanceof MissingPepperError) {
        writeAudit(env, ctx, {
          event: "token.issue",
          ok: false,
          reason: "misconfigured",
          userId: body.userId,
          authMethod: auth.authMethod,
          ip,
          scope,
        });
        return c.json(
          { error: "misconfigured", error_description: "HMAC_PEPPER not configured" },
          503
        );
      }
      writeAudit(env, ctx, {
        event: "token.issue",
        ok: false,
        reason: "internal_error",
        userId: body.userId,
        authMethod: auth.authMethod,
        ip,
        scope,
      });
      return c.json(
        { error: "internal_error", error_description: "internal error" },
        500
      );
    }
  });

  // POST /v1/tokens/:tokenId/renew — self-renew or admin-rotate (C-Server-2)
  v1.post("/tokens/:tokenId/renew", async (c) => {
    const auth = c.get("auth");
    const env = c.env;
    const ctx = c.executionCtx as ExecutionContext;
    const ip = auth.ip;
    const scope = auth.scopes.join(" ");
    const tokenId = c.req.param("tokenId");

    // Authorization: self OR admin
    const isSelf = auth.tokenId !== undefined && auth.tokenId === tokenId;
    const isAdmin = auth.scopes.includes("dovecote:admin");
    if (!isSelf && !isAdmin) {
      writeAudit(env, ctx, {
        event: "token.issue",
        ok: false,
        reason: "forbidden",
        tokenId,
        authMethod: auth.authMethod,
        ip,
        scope,
      });
      return c.json(
        { error: "forbidden", error_description: "Cannot renew another token without dovecote:admin" },
        403
      );
    }

    // Rate limit
    const rl = await services.checkRateLimit(env.OAUTH_KV, ip, "tokens");
    if (!rl.allowed) {
      writeAudit(env, ctx, {
        event: "token.issue",
        ok: false,
        reason: "rate_limited",
        tokenId,
        authMethod: auth.authMethod,
        ip,
        scope,
      });
      return c.json(
        { error: "rate_limited", error_description: "Too many requests" },
        429,
        { "Retry-After": "60" }
      );
    }

    // Parse body (optional)
    let rawBody: unknown = {};
    try {
      const text = await c.req.text();
      if (text.length > 0) rawBody = JSON.parse(text);
    } catch {
      return c.json(
        { error: "invalid_request", error_description: "Invalid JSON body" },
        400
      );
    }
    const parsed = tokenRenewRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message || "Invalid request";
      return c.json({ error: "invalid_request", error_description: msg }, 400);
    }
    const body = parsed.data;

    // Read old metadata
    const getMeta =
      services.getTokenMetadataByTokenId ?? _getTokenMetadataByTokenId;
    const oldMeta = await getMeta(tokenId, env);
    if (!oldMeta) {
      writeAudit(env, ctx, {
        event: "token.issue",
        ok: false,
        reason: "not_found",
        tokenId,
        authMethod: auth.authMethod,
        ip,
        scope,
      });
      return c.json(
        { error: "not_found", error_description: "Token not found" },
        404
      );
    }

    try {
      const ttlSeconds = body.expiresIn
        ? expiresInToSeconds(body.expiresIn)
        : undefined;
      const result = await services.issueToken(
        {
          userId: oldMeta.userId,
          scopes: oldMeta.scopes,
          label: oldMeta.label,
          ttlSeconds,
        },
        env
      );

      // RACE-SAFE ORDER: new keys persisted (inside issueToken) BEFORE deleting old.
      const deleteFn = services.deleteTokenEntries ?? _deleteTokenEntries;
      try {
        await deleteFn(oldMeta, env);
      } catch {
        // Old-key delete failure does not break the response — new token is valid.
      }

      writeAudit(env, ctx, {
        event: "token.issue",
        ok: true,
        userId: oldMeta.userId,
        tokenId: result.tokenId,
        scopes: oldMeta.scopes,
        authMethod: auth.authMethod,
        ip,
        scope,
      });

      return c.json(
        {
          token: result.token,
          tokenId: result.tokenId,
          userId: oldMeta.userId,
          scopes: oldMeta.scopes,
          expiresAt: result.expiresAt,
          ...(oldMeta.label ? { label: oldMeta.label } : {}),
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
      if (err instanceof KVWriteError) {
        return c.json(
          { error: "internal_error", error_description: "internal error" },
          500
        );
      }
      writeAudit(env, ctx, {
        event: "token.issue",
        ok: false,
        reason: "internal_error",
        tokenId,
        authMethod: auth.authMethod,
        ip,
        scope,
      });
      return c.json(
        { error: "internal_error", error_description: "internal error" },
        500
      );
    }
  });

  // DELETE /v1/tokens/:tokenId — admin-gated revocation (C2.5.b)
  v1.delete("/tokens/:tokenId", async (c) => {
    const auth = c.get("auth");
    const env = c.env;
    const ctx = c.executionCtx as ExecutionContext;
    const ip = auth.ip;
    const scope = auth.scopes.join(" ");
    const tokenId = c.req.param("tokenId");

    if (!auth.scopes.includes("dovecote:admin")) {
      writeAudit(env, ctx, {
        event: "token.revoke",
        ok: false,
        reason: "forbidden",
        tokenId,
        authMethod: auth.authMethod,
        ip,
        scope,
      });
      return c.json(
        { error: "forbidden", error_description: "Missing scope: dovecote:admin" },
        403
      );
    }

    const rl = await services.checkRateLimit(env.OAUTH_KV, ip, "tokens");
    if (!rl.allowed) {
      writeAudit(env, ctx, {
        event: "token.revoke",
        ok: false,
        reason: "rate_limited",
        tokenId,
        authMethod: auth.authMethod,
        ip,
        scope,
      });
      return c.json(
        { error: "rate_limited", error_description: "Too many requests" },
        429,
        { "Retry-After": "60" }
      );
    }

    try {
      const result = await services.revokeToken({ tokenId, env }, env);
      writeAudit(env, ctx, {
        event: "token.revoke",
        ok: true,
        ...(result.revoked ? {} : { reason: "not_found" }),
        tokenId,
        authMethod: auth.authMethod,
        ip,
        scope,
      });
      return c.json(
        {
          revoked: result.revoked,
          tokenId,
          notice: "May remain usable for up to 60 seconds",
        },
        200
      );
    } catch (_err) {
      writeAudit(env, ctx, {
        event: "token.revoke",
        ok: false,
        reason: "internal_error",
        tokenId,
        authMethod: auth.authMethod,
        ip,
        scope,
      });
      return c.json(
        { error: "internal_error", error_description: "internal error" },
        500
      );
    }
  });

  return v1;
}

// Default-wired instance used in production (mounted by src/index.ts).
const v1 = createV1App({
  sendNotification: _sendNotification,
  listChannels: _listChannels,
  readEnv: _readEnv,
  issueToken: _issueToken,
  revokeToken: _revokeToken,
  checkRateLimit: _checkRateLimit,
  getTokenMetadataByTokenId: _getTokenMetadataByTokenId,
  deleteTokenEntries: _deleteTokenEntries,
  listUserTokens: _listUserTokens,
  listAllTokens: _listAllTokens,
});

export default v1;
