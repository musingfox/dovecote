import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { Env } from "../types.js";
import type { AuthCtx } from "../auth/ctx.js";
import { listChannels } from "../services/channels.js";
import { ScopeError } from "../services/errors.js";

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
      try {
        const channels = listChannels(env, auth);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(channels, null, 2),
            },
          ],
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
