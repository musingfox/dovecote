import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "./types.js";
import { registerListChannelsTool } from "./tools/list-channels.js";
import { registerSendNotificationTool } from "./tools/send-notification.js";

/**
 * Creates an MCP server instance with dovecote configuration
 */
export function createMCPServer(env: Env): McpServer {
  const server = new McpServer({
    name: "dovecote-mcp-server",
    version: "1.0.0",
  });

  registerListChannelsTool(server, env);
  registerSendNotificationTool(server, env);

  return server;
}
