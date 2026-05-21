import type { Env } from "../types.js";
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { AuthMethod } from "./ctx.js";

/**
 * Audit event types
 * Common fields across all variants:
 * - authMethod: How the caller authenticated (oauth, api_token, admin_token, none)
 * - ip: Client IP address (from CF-Connecting-IP header)
 * - scope: The operation scope being performed
 * - ok: Whether the operation succeeded
 * - reason?: Optional failure reason
 * - tokenId?: Optional token identifier (for token-related events)
 */
export type AuditEvent =
  // OAuth authorization (pre-token, so no tokenId)
  | (AuditCommon & { event: "authorize"; userId: string })
  // Read environment profile
  | (AuditCommon & { event: "env.read"; userId: string; profile: string })
  // Revoke an OAuth grant
  | (AuditCommon & { event: "admin.revoke"; grantId: string; tokenId?: string })
  // Bootstrap an OAuth client
  | (AuditCommon & { event: "admin.bootstrap"; clientName: string; tokenId?: string })
  // Send notification
  | (AuditCommon & { event: "notify.send"; userId: string; channel: string })
  // Issue a new API token (NEW) — userId/tokenId/scopes optional on failure paths
  // (e.g., 403 before reading body, 429 before issuing) per PR-E
  | (AuditCommon & { event: "token.issue"; userId?: string; tokenId?: string; scopes?: string[] })
  // Revoke an API token (NEW) — tokenId optional on failure paths per PR-E
  | (AuditCommon & { event: "token.revoke"; tokenId?: string })
  // Use an API token on a route (NEW). On failure branches the tokenId/route may be absent
  // because the request is rejected before identification (missing header, malformed bearer).
  | (AuditCommon & { event: "token.use"; route?: string; userId?: string });

/**
 * Common fields on all audit event variants
 */
type AuditCommon = {
  authMethod: AuthMethod;
  ip: string;
  scope: string;
  ok: boolean;
  reason?: string;
  tokenId?: string;
};

/**
 * Free text fields that should be JSON-stringified (double-escaped)
 * to prevent log injection via newlines/escape sequences
 */
const FREE_TEXT_FIELDS = ["reason", "channel", "profile", "clientName", "route"] as const;

/**
 * Write audit event to console log and KV store
 * Non-blocking, failure-tolerant (C3)
 * Sanitizes free-text fields to prevent log injection (D2)
 *
 * @param env - Cloudflare Workers environment bindings
 * @param ctx - ExecutionContext for waitUntil
 * @param event - Audit event data
 */
export function writeAudit(env: Env, ctx: ExecutionContext, event: AuditEvent): void {
  const ts = Math.floor(Date.now() / 1000);
  const uuid = crypto.randomUUID();

  const entry: Record<string, unknown> = {
    ts,
    ...event,
  };

  // Sanitize free-text fields to prevent log injection
  // For each free-text field, if present and string-valued, replace with
  // the JSON-encoded string (without the surrounding quotes).
  // This turns literal newlines into the two-character sequence \n,
  // and escape sequences into their JSON-escaped form.
  // Example: "line1\nline2" becomes "line1\\nline2" in the logged JSON.
  for (const key of FREE_TEXT_FIELDS) {
    const value = entry[key];
    if (typeof value === "string") {
      // JSON.stringify adds quotes; slice them off
      entry[key] = JSON.stringify(value).slice(1, -1);
    }
  }

  // Console log (synchronous)
  console.log(JSON.stringify(entry));

  // KV persist (async, fire-and-forget with TTL = 90 days)
  const key = `audit:${ts}:${uuid}`;
  ctx.waitUntil(
    env.OAUTH_KV.put(key, JSON.stringify(entry), {
      expirationTtl: 7_776_000, // 90 days in seconds
    }).catch(() => {
      // Absorb KV failures (don't block)
    })
  );
}
