/**
 * Single-issue pipeline: shared by auth-exchange and auth-github-oidc.
 *
 * Pipeline: checkRateLimit (if provided) → issueToken → response + audit.
 *
 * All side-effecting operations are injected via opts.services so callers
 * can stub them in tests. checkRateLimit is optional — callers that already
 * ran rate-limit in their head (e.g. OIDC, which gates before resolveUserId)
 * omit it from services, and the helper skips the RL step.
 */

import type { KVNamespace, ExecutionContext } from "@cloudflare/workers-types";
import type { Env } from "../types.js";
import { InvalidScopeError, KVWriteError, MissingPepperError, type IssueResult } from "./api-token.js";
import { writeAudit } from "./audit.js";
import type { RateLimitResult } from "./rate-limit.js";

export interface IssueTokenFlowServices {
  issueToken: (
    params: { userId: string; scopes: string[]; label?: string; ttlSeconds?: number },
    env: Env,
  ) => Promise<IssueResult>;
  checkRateLimit?: (
    kv: KVNamespace,
    ip: string,
    namespace: string,
    limit?: number,
  ) => Promise<RateLimitResult>;
}

export interface IssueTokenFlowOpts {
  env: Env;
  ctx: ExecutionContext;
  ip: string;
  userId: string;
  scopes: string[];
  label?: string;
  ttlSeconds?: number;
  rateLimitNamespace?: string;
  rateLimitLimit?: number;
  authMethod: string;
  /**
   * The audit event type to use (default: "token.issue").
   * Use "auth.exchange.oidc" to preserve per-endpoint audit shape.
   */
  auditEvent?: string;
  auditScope: string;
  /**
   * Extra fields merged into every audit entry (e.g. issuer for OIDC).
   * Values are merged after all standard fields.
   */
  auditExtras?: Record<string, unknown>;
  successStatus: number;
  /** Extra fields merged into the success audit entry (on top of auditExtras) */
  successAuditExtras?: Record<string, unknown>;
  /**
   * Per-endpoint error disposition:
   *   "surface" — admin / device-poll: KVWriteError -> 500 "Failed to persist token";
   *               unknown Error -> rethrow (lets Hono default-500 handle it).
   *   "swallow" — auth-exchange / oidc: both KVWriteError and unknown -> 500 generic
   *               "internal error" JSON, no rethrow.
   * Default: "swallow".
   */
  errorMode?: "surface" | "swallow";
  /**
   * Custom handling for InvalidScopeError.
   * If provided: emits audit with auditReason and returns the given body (400).
   * If omitted: returns {error:"invalid_request", error_description:err.message} with no audit.
   */
  invalidScopeOpts?: {
    auditReason?: string;
    body?: (err: Error) => Record<string, unknown>;
  };
  /**
   * Custom handling for MissingPepperError.
   * If provided: emits audit with auditReason before returning 503.
   * If omitted: returns 503 with no audit.
   */
  missingPepperOpts?: {
    auditReason?: string;
  };
  /**
   * Post-issue hook called after issueToken succeeds, before the success audit.
   * If the hook throws, the error is swallowed (the 201 response is still returned).
   * Default: undefined (no hook).
   */
  onIssued?: (result: IssueResult) => Promise<void>;
  /**
   * When true, error-path audit entries for InvalidScopeError, MissingPepperError,
   * and KVWriteError are suppressed (not written). Default: false (audits are written).
   */
  suppressErrorAudit?: boolean;
  /**
   * When set, the unknown-error audit entry uses this value as `tokenId` instead of
   * `userId`. Default: undefined (unknown-error audit includes userId, no tokenId).
   */
  unknownAuditTokenId?: string;
  services: IssueTokenFlowServices;
}

/**
 * Minimal Hono-ish context interface: only the json() helper is required.
 */
interface MinimalContext {
  json: (body: unknown, status?: number, headers?: Record<string, string>) => Response;
}

export async function issueTokenFlow(
  c: MinimalContext,
  opts: IssueTokenFlowOpts,
): Promise<Response> {
  const {
    env,
    ctx,
    ip,
    userId,
    scopes,
    label,
    ttlSeconds,
    rateLimitNamespace,
    rateLimitLimit,
    authMethod,
    auditEvent = "token.issue",
    auditScope,
    auditExtras,
    successStatus,
    successAuditExtras,
    errorMode = "swallow",
    invalidScopeOpts,
    missingPepperOpts,
    onIssued,
    suppressErrorAudit = false,
    unknownAuditTokenId,
    services,
  } = opts;

  // 1. Rate limit (optional — omit from services to skip)
  if (services.checkRateLimit) {
    const rl = await services.checkRateLimit(env.OAUTH_KV, ip, rateLimitNamespace ?? "", rateLimitLimit);
    if (!rl.allowed) {
      writeAudit(env, ctx, {
        event: auditEvent,
        ok: false,
        reason: "rate_limited",
        userId,
        authMethod: authMethod as any,
        ip,
        scope: auditScope,
        ...(auditExtras ?? {}),
      } as any);
      return c.json({ error: "rate_limited", error_description: "Too many requests" }, 429, { "Retry-After": "60" });
    }
  }

  // 2. Issue token
  try {
    const result = await services.issueToken({ userId, scopes, label, ttlSeconds }, env);
    // Post-issue hook (e.g. delete old token on renew). Throw swallowed.
    if (onIssued) {
      try {
        await onIssued(result);
      } catch {
        // Hook failure does not affect the response.
      }
    }
    writeAudit(env, ctx, {
      event: auditEvent,
      ok: true,
      userId,
      tokenId: result.tokenId,
      authMethod: authMethod as any,
      ip,
      scope: auditScope,
      ...(auditExtras ?? {}),
      ...(successAuditExtras ?? {}),
    } as any);
    return c.json(
      {
        token: result.token,
        tokenId: result.tokenId,
        userId,
        scopes,
        expiresAt: result.expiresAt,
        ...(label ? { label } : {}),
      },
      successStatus,
    );
  } catch (err) {
    if (err instanceof InvalidScopeError) {
      if (invalidScopeOpts) {
        if (!suppressErrorAudit && invalidScopeOpts.auditReason) {
          writeAudit(env, ctx, {
            event: auditEvent,
            ok: false,
            reason: invalidScopeOpts.auditReason,
            userId,
            authMethod: authMethod as any,
            ip,
            scope: auditScope,
            ...(auditExtras ?? {}),
          } as any);
        }
        const body = invalidScopeOpts.body
          ? invalidScopeOpts.body(err as Error)
          : { error: "invalid_request", error_description: (err as Error).message };
        return c.json(body, 400);
      }
      return c.json(
        { error: "invalid_request", error_description: (err as Error).message },
        400,
      );
    }
    if (err instanceof MissingPepperError) {
      if (!suppressErrorAudit && missingPepperOpts?.auditReason) {
        writeAudit(env, ctx, {
          event: auditEvent,
          ok: false,
          reason: missingPepperOpts.auditReason,
          userId,
          authMethod: authMethod as any,
          ip,
          scope: auditScope,
          ...(auditExtras ?? {}),
        } as any);
      }
      return c.json(
        { error: "misconfigured", error_description: "HMAC_PEPPER not configured" },
        503,
      );
    }
    if (err instanceof KVWriteError) {
      if (!suppressErrorAudit) {
        writeAudit(env, ctx, {
          event: auditEvent,
          ok: false,
          reason: "internal_error",
          userId,
          authMethod: authMethod as any,
          ip,
          scope: auditScope,
          ...(auditExtras ?? {}),
        } as any);
      }
      if (errorMode === "surface") {
        return c.json(
          { error: "internal_error", error_description: "Failed to persist token" },
          500,
        );
      }
      return c.json(
        { error: "internal_error", error_description: "internal error" },
        500,
      );
    }
    // Unknown error
    if (errorMode === "surface") {
      throw err;
    }
    // Unknown error audit: use unknownAuditTokenId if provided (renew path),
    // otherwise use userId (default — existing 4 callers unaffected).
    if (unknownAuditTokenId !== undefined) {
      writeAudit(env, ctx, {
        event: auditEvent,
        ok: false,
        reason: "internal_error",
        tokenId: unknownAuditTokenId,
        authMethod: authMethod as any,
        ip,
        scope: auditScope,
        ...(auditExtras ?? {}),
      } as any);
    } else {
      writeAudit(env, ctx, {
        event: auditEvent,
        ok: false,
        reason: "internal_error",
        userId,
        authMethod: authMethod as any,
        ip,
        scope: auditScope,
        ...(auditExtras ?? {}),
      } as any);
    }
    return c.json(
      { error: "internal_error", error_description: "internal error" },
      500,
    );
  }
}
