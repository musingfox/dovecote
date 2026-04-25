import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { Env } from "../types.js";
import type { AuthCtx } from "../auth/ctx.js";
import { sendToChannel } from "../channels/registry.js";
import { messageContentSchema } from "../channels/schemas.js";

export function registerSendNotificationTool(
  server: McpServer,
  env: Env,
  _auth: AuthCtx,
  _ctx: ExecutionContext
): void {
  // @ts-expect-error - zod peer dependency type conflict with MCP SDK
  server.tool(
    "send_notification",
    "Send a notification message (text, embed, or both) to a channel",
    {
      channel: z.string().describe("Channel ID"),
      content: messageContentSchema.describe("Message content: supply text, embed, or both. Channels that support embed (e.g. Telegram) will render it as formatted HTML."),
    },
    async ({ channel, content }) => {
      const result = await sendToChannel(channel, content, env);
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
    }
  );
}
