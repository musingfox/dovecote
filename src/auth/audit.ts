import type { Env } from "../types.js";
import type { ExecutionContext } from "@cloudflare/workers-types";

/**
 * Audit event types
 */
export type AuditEvent =
  | { event: "authorize"; userId: string; ok: boolean; reason?: string }
  | { event: "env.read"; userId: string; profile: string; ok: boolean; reason?: string }
  | { event: "admin.revoke"; grantId: string; ok: boolean; reason?: string }
  | { event: "admin.bootstrap"; clientName: string; ok: boolean; reason?: string };

/**
 * Write audit event to console log and KV store
 * Non-blocking, failure-tolerant (C3)
 *
 * @param env - Cloudflare Workers environment bindings
 * @param ctx - ExecutionContext for waitUntil
 * @param event - Audit event data
 */
export function writeAudit(env: Env, ctx: ExecutionContext, event: AuditEvent): void {
  const ts = Math.floor(Date.now() / 1000);
  const uuid = crypto.randomUUID();

  const entry = {
    ts,
    ...event,
  };

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
