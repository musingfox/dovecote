import type { ExecutionContext } from "@cloudflare/workers-types";
import type { Env, SendResult } from "../types.js";
import type { AuthCtx } from "../auth/ctx.js";
import type { MessageContent } from "../channels/types.js";
import { sendToChannel } from "../channels/registry.js";
import { writeAudit } from "../auth/audit.js";
import { ScopeError } from "./errors.js";

export async function sendNotification(
  env: Env,
  auth: AuthCtx,
  ctx: ExecutionContext,
  { channel, content }: { channel: string; content: MessageContent }
): Promise<SendResult> {
  if (!auth.scopes.includes("dovecote:notify")) {
    writeAudit(env, ctx, {
      event: "notify.send",
      userId: auth.userId,
      channel: channel.slice(0, 256),
      ok: false,
      reason: "forbidden",
    });
    throw new ScopeError("dovecote:notify");
  }

  return sendToChannel(channel, content, env);
}
