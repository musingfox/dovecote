import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { Env } from "../types.js";
import type { AuthCtx } from "../auth/ctx.js";
import { messageContentSchema } from "../channels/schemas.js";
import { sendNotification } from "../services/notifications.js";
import { ScopeError } from "../services/errors.js";

export function registerSendNotificationTool(
  server: McpServer,
  env: Env,
  auth: AuthCtx,
  ctx: ExecutionContext
): void {
  server.tool(
    "send_notification",
    "Send a notification message (text, embed, or both) to a channel",
    {
      channel: z.string().describe("Channel ID"),
      content: messageContentSchema.describe("Message content: supply text, embed, or both. Channels that support embed (e.g. Telegram) will render it as formatted HTML."),
    },
    async ({ channel, content }) => {
      try {
        const result = await sendNotification(env, auth, ctx, { channel, content });
        if (result.success) {
          const response: Record<string, unknown> = {
            channel,
            messageId: result.messageId,
          };
          if (result.detail) {
            response.detail = result.detail;
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(response),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Failed to send to ${channel}: ${result.error}`,
            },
          ],
          isError: true,
        };
      } catch (err) {
        if (err instanceof ScopeError) {
          return {
            content: [
              {
                type: "text",
                text: `Forbidden: missing scope ${err.requiredScope}`,
              },
            ],
            isError: true,
          };
        }
        throw err;
      }
    }
  );
}
