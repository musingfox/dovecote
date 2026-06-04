/**
 * Admin token-issuance carve-out — `POST /admin/issue-token`.
 *
 * Mints a `dvct_*` runtime token directly with admin-bearer auth, skipping the
 * OAuth bootstrap-client + `/v1/auth/exchange` round-trip. Intended for the
 * operator's personal CLI flow (setup-wizard step 6). External third-party
 * consumers (Claude.ai, GH Actions used by others) keep using the OAuth path.
 *
 * Mounted on the root app BEFORE the `/v1/*` bearer middleware (ADR 0001
 * carve-out): the route authenticates by ADMIN_REVOKE_TOKEN, not by a
 * `dvct_*` bearer.
 *
 * Validation order (matches device-authorize, NOT bootstrap-client):
 *   1. Per-IP rate-limit (namespace "admin", 60/min)        → 429
 *   2. Authorization header present + Bearer + correct      → 401
 *   3. Body parses + schema valid                           → 400
 *   4. `user:<userId>` exists in OAUTH_KV                   → 404
 *   5. HMAC_PEPPER configured                                → 503
 *   6. issueToken → 200 with `{ token, tokenId, ... }`
 *
 * No gating flag (admin token + rate-limit is sufficient — D1).
 */

import { Hono } from "hono";
import type { ExecutionContext, KVNamespace } from "@cloudflare/workers-types";
import type { Env } from "./types.js";
import {
  adminIssueTokenRequestSchema,
  ADMIN_ISSUE_DEFAULT_DAYS,
  ADMIN_ISSUE_DEFAULT_LABEL,
} from "./contracts/admin.js";
import {
  KVWriteError,
  type IssueResult,
} from "./auth/api-token.js";
import type { RateLimitResult } from "./auth/rate-limit.js";
import { writeAudit } from "./auth/audit.js";
import { issueTokenFlow } from "./auth/issue-token-flow.js";

const ADMIN_RATE_LIMIT_NAMESPACE = "admin";
const ADMIN_RATE_LIMIT_PER_MIN = 60;
const ADMIN_AUDIT_SCOPE = "dovecote:admin";

/**
 * Timing-safe string compare — mirrors the inline pattern in
 * `src/auth/authorize.ts` / `src/auth/csrf.ts` / `src/auth/legacy-auth.ts`.
 * Kept local to avoid widening the helper surface.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) {
    r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return r === 0;
}

export type AdminIssueTokenServices = {
  issueToken: (
    params: { userId: string; scopes: string[]; label?: string; ttlSeconds?: number },
    env: Env,
  ) => Promise<IssueResult>;
  checkRateLimit: (
    kv: KVNamespace,
    ip: string,
    namespace: string,
    limit?: number,
  ) => Promise<RateLimitResult>;
};

type Vars = { Bindings: Env };

export function createAdminIssueTokenApp(services: AdminIssueTokenServices) {
  const app = new Hono<Vars>();

  app.post("/admin/issue-token", async (c) => {
    const env = c.env;
    const ctx = c.executionCtx as ExecutionContext;
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";

    // 1. Rate-limit FIRST (per p4.3 ordering — avoids unauth amplification).
    //    Delegated to the shared pipeline below (step 6). Kept at top of handler
    //    via the pipeline's checkRateLimit which runs before issueToken.
    //    We defer the full call to issueTokenFlow at step 6 with all resolved
    //    parameters. For the early rate-limit path we rely on the pipeline
    //    to check RL and return 429 before reaching issueToken.
    //    To preserve the "RL first" order, we check RL here directly and bail out
    //    before any other work, matching the original validation order.
    const rlEarly = await services.checkRateLimit(
      env.OAUTH_KV,
      ip,
      ADMIN_RATE_LIMIT_NAMESPACE,
      ADMIN_RATE_LIMIT_PER_MIN,
    );
    if (!rlEarly.allowed) {
      writeAudit(env, ctx, {
        event: "token.issue",
        ok: false,
        reason: "rate_limited",
        authMethod: "admin_token",
        ip,
        scope: ADMIN_AUDIT_SCOPE,
      });
      return c.json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
    }

    // 2. Authorization: Bearer <ADMIN_REVOKE_TOKEN>, constant-time compare.
    const authHeader = c.req.header("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      writeAudit(env, ctx, {
        event: "token.issue",
        ok: false,
        reason: "auth_failed",
        authMethod: "admin_token",
        ip,
        scope: ADMIN_AUDIT_SCOPE,
      });
      return c.json({ error: "unauthorized" }, 401);
    }
    const presented = authHeader.substring(7);
    if (
      !env.ADMIN_REVOKE_TOKEN ||
      !timingSafeEqual(presented, env.ADMIN_REVOKE_TOKEN)
    ) {
      writeAudit(env, ctx, {
        event: "token.issue",
        ok: false,
        reason: "auth_failed",
        authMethod: "admin_token",
        ip,
        scope: ADMIN_AUDIT_SCOPE,
      });
      return c.json({ error: "unauthorized" }, 401);
    }

    // 3. Parse + validate body.
    let raw: unknown = {};
    try {
      const text = await c.req.text();
      if (text.length > 0) raw = JSON.parse(text);
    } catch {
      writeAudit(env, ctx, {
        event: "token.issue",
        ok: false,
        reason: "invalid_body",
        authMethod: "admin_token",
        ip,
        scope: ADMIN_AUDIT_SCOPE,
      });
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const parsed = adminIssueTokenRequestSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const message = issue?.message ?? "invalid_body";
      writeAudit(env, ctx, {
        event: "token.issue",
        ok: false,
        reason: "invalid_body",
        authMethod: "admin_token",
        ip,
        scope: ADMIN_AUDIT_SCOPE,
      });
      return c.json({ error: message }, 400);
    }
    const body = parsed.data;

    // 4. User existence check (D3) — prevents minting tokens for users that
    //    can't authenticate later. `user:<userId>` is the canonical record.
    let userRecord: string | null;
    try {
      userRecord = await env.OAUTH_KV.get(`user:${body.userId}`);
    } catch (e) {
      writeAudit(env, ctx, {
        event: "token.issue",
        ok: false,
        reason: "internal_error",
        userId: body.userId,
        authMethod: "admin_token",
        ip,
        scope: ADMIN_AUDIT_SCOPE,
      });
      return c.json(
        { error: "internal_error", error_description: (e as Error).message },
        500,
      );
    }
    if (!userRecord) {
      writeAudit(env, ctx, {
        event: "token.issue",
        ok: false,
        reason: "user_not_found",
        userId: body.userId,
        authMethod: "admin_token",
        ip,
        scope: ADMIN_AUDIT_SCOPE,
      });
      return c.json({ error: "user_not_found" }, 404);
    }

    // 5. HMAC_PEPPER precheck (issueToken would also throw, but we surface
    //    the misconfig with a distinct status BEFORE attempting to mint).
    if (!env.HMAC_PEPPER) {
      writeAudit(env, ctx, {
        event: "token.issue",
        ok: false,
        reason: "misconfigured",
        userId: body.userId,
        authMethod: "admin_token",
        ip,
        scope: ADMIN_AUDIT_SCOPE,
      });
      return c.json(
        { error: "misconfigured", error_description: "HMAC_PEPPER not configured" },
        503,
      );
    }

    // 6. Mint token via shared pipeline (RL already ran in step 1 above).
    const expiresInDays = body.expiresInDays ?? ADMIN_ISSUE_DEFAULT_DAYS;
    const label = body.label ?? ADMIN_ISSUE_DEFAULT_LABEL;
    const ttlSeconds = expiresInDays * 86400;

    return issueTokenFlow(c, {
      env,
      ctx,
      ip,
      userId: body.userId,
      scopes: body.scopes,
      label,
      ttlSeconds,
      rateLimitNamespace: ADMIN_RATE_LIMIT_NAMESPACE,
      authMethod: "admin_token",
      auditScope: ADMIN_AUDIT_SCOPE,
      successStatus: 200,
      errorMode: "surface",
      successAuditExtras: { reason: "admin_issue", scopes: body.scopes },
      invalidScopeOpts: {
        auditReason: "invalid_body",
        body: (err) => ({ error: err.message }),
      },
      services: {
        issueToken: services.issueToken,
        // checkRateLimit intentionally omitted — already ran in step 1.
      },
    });
  });

  return app;
}
