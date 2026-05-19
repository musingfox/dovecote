import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { Env } from "../types.js";
import type { AuthCtx } from "../auth/ctx.js";
import { getChannelConfigs } from "../channels/registry.js";

export function registerListChannelsTool(
  server: McpServer,
  env: Env,
  auth: AuthCtx,
  _ctx: ExecutionContext
): void {
  server.tool(
    "list_channels",
    "List all available notification channels",
    {},
    async () => {
      if (!auth.scopes.includes("dovecote:notify")) {
        return {
          content: [
            {
              type: "text",
              text: "Forbidden: missing scope dovecote:notify",
            },
          ],
          isError: true,
        };
      }

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
