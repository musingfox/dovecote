import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { Env } from "./types.js";
import type { AuthCtx } from "./auth/ctx.js";
import { registerListChannelsTool } from "./tools/list-channels.js";
import { registerSendNotificationTool } from "./tools/send-notification.js";
import { registerGetEnvTool } from "./tools/get-env.js";

/**
 * Creates an MCP server instance with dovecote configuration
 * All three parameters are required (C5)
 */
export function createMCPServer(
  env: Env,
  auth: AuthCtx,
  ctx: ExecutionContext
): McpServer {
  const server = new McpServer({
    name: "dovecote-mcp-server",
    version: "1.0.0",
  });

  registerListChannelsTool(server, env, auth, ctx);
  registerSendNotificationTool(server, env, auth, ctx);
  registerGetEnvTool(server, env, auth, ctx);

  return server;
}
