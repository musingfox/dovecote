import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../types.js";
import { sendToChannel } from "../channels/registry.js";

export function registerSendNotificationTool(server: McpServer, env: Env): void {
  // @ts-expect-error - zod peer dependency type conflict with MCP SDK
  server.tool(
    "send_notification",
    "Send a message to a notification channel",
    {
      channel: z.string().describe("Channel ID"),
      message: z.string().describe("Message text"),
    },
    async ({ channel, message }) => {
      const result = await sendToChannel(channel, message, env);
      if (result.success) {
        const text = result.messageId
          ? `Sent to ${channel}: ${result.messageId}`
          : `Sent to ${channel}`;
        return {
          content: [
            {
              type: "text",
              text,
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
