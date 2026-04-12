import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../types.js";
import { sendToChannel } from "../channels/registry.js";
import { messageContentSchema } from "../channels/schemas.js";

export function registerSendNotificationTool(server: McpServer, env: Env): void {
  // @ts-expect-error - zod peer dependency type conflict with MCP SDK
  server.tool(
    "send_notification",
    "Send a message to a notification channel",
    {
      channel: z.string().describe("Channel ID"),
      content: messageContentSchema.describe("Message content with optional text and embed"),
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
