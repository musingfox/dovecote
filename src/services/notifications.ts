import type { ExecutionContext } from "@cloudflare/workers-types";
import type { Env, SendResult } from "../types.js";
import type { AuthCtx } from "../auth/ctx.js";
import type { MessageContent } from "../channels/types.js";
import { sendToChannel, UNKNOWN_CHANNEL_ERROR } from "../channels/registry.js";
import { writeAudit } from "../auth/audit.js";
import { ScopeError } from "./errors.js";

/**
 * The one writer of `notify.send`: REST and MCP both reach it, so each send
 * attempt leaves one record naming the dvct token behind it. The label is a
 * snapshot, since the token's record (and its label) is deleted on revoke
 * while the audit entry lives 90 days.
 */
export function recordNotifySend(
  env: Env,
  ctx: ExecutionContext,
  auth: AuthCtx,
  outcome: { ok: boolean; reason?: string; channel?: string }
): void {
  writeAudit(env, ctx, {
    event: "notify.send",
    ok: outcome.ok,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    userId: auth.userId,
    ...(outcome.channel !== undefined ? { channel: outcome.channel.slice(0, 256) } : {}),
    ...(auth.tokenId ? { tokenId: auth.tokenId } : {}),
    ...(auth.label !== undefined ? { label: auth.label } : {}),
    authMethod: auth.authMethod,
    ip: auth.ip,
    scope: "dovecote:notify",
  });
}

export async function sendNotification(
  env: Env,
  auth: AuthCtx,
  ctx: ExecutionContext,
  { channel, content }: { channel: string; content: MessageContent }
): Promise<SendResult> {
  if (!auth.scopes.includes("dovecote:notify")) {
    recordNotifySend(env, ctx, auth, { ok: false, reason: "forbidden", channel });
    throw new ScopeError("dovecote:notify");
  }

  let result: SendResult;
  try {
    result = await sendToChannel(channel, content, env);
  } catch (err) {
    recordNotifySend(env, ctx, auth, { ok: false, reason: "internal_error", channel });
    throw err;
  }

  if (result.success) {
    recordNotifySend(env, ctx, auth, { ok: true, channel });
  } else {
    const reason = result.error === UNKNOWN_CHANNEL_ERROR ? "unknown_channel" : "upstream_error";
    recordNotifySend(env, ctx, auth, { ok: false, reason, channel });
  }
  return result;
}
