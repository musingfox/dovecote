import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { Env } from "./types.js";
import type { AuthCtx } from "./auth/ctx.js";
import { registerListChannelsTool } from "./tools/list-channels.js";
import { registerSendNotificationTool } from "./tools/send-notification.js";

// GHSA-46jr-4wx8-v453: the SDK leaves this unlimited unless set. The richest
// send_notification call is 25 + 4 per embed field, 125 at Discord's 25-field
// cap, so 1,000 leaves room for Telegram embeds with many fields.
export const MCP_MAX_TOOL_INPUT_ELEMENTS = 1_000;

/**
 * Creates an MCP server instance with dovecote configuration
 * All three parameters are required (C5)
 */
export function createMCPServer(
  env: Env,
  auth: AuthCtx,
  ctx: ExecutionContext
): McpServer {
  const server = new McpServer(
    {
      name: "dovecote-mcp-server",
      version: "1.0.0",
    },
    { maxToolInputElements: MCP_MAX_TOOL_INPUT_ELEMENTS }
  );

  registerListChannelsTool(server, env, auth, ctx);
  registerSendNotificationTool(server, env, auth, ctx);

  return server;
}
