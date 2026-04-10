import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "../types.js";
import { getChannelConfigs } from "../channels/registry.js";

export function registerListChannelsTool(server: McpServer, env: Env): void {
  server.tool(
    "list_channels",
    "List all available notification channels",
    {},
    async () => {
      const channels = getChannelConfigs(env);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(channels, null, 2),
          },
        ],
      };
    }
  );
}
