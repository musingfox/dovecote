import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types.js";
import { extractAuth, enrichAuthFromRequest } from "./auth/ctx.js";
import { createMCPServer } from "./server.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ATTACHMENT_DATA_MAX } from "./contracts/notifications.js";

// send_notification accepts up to ATTACHMENT_DATA_MAX of base64, which is above the
// SDK's 4 MiB default; 1 MiB covers channel, text, embed and the JSON-RPC envelope.
// GHSA-46jr-4wx8-v453 asks for an explicit cap sized to what the tools need.
export const MCP_MAX_REQUEST_BODY_SIZE = ATTACHMENT_DATA_MAX + 1024 * 1024;

const app = new Hono<{ Bindings: Env }>();

// CORS middleware
app.use(
  "/mcp",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "mcp-session-id", "Last-Event-ID", "mcp-protocol-version"],
    exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
  })
);

// MCP transport endpoint - stateless mode
app.post("/mcp", async (c) => {
  // Extract auth from ExecutionContext (fail-closed)
  const auth = extractAuth(c.executionCtx);
  // Enrich with current request's edge metadata
  const enrichedAuth = enrichAuthFromRequest(auth, c.req.raw, auth.authMethod);

  // Create new transport and server for each request (stateless mode)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    maxRequestBodySize: MCP_MAX_REQUEST_BODY_SIZE,
  });

  const server = createMCPServer(c.env, enrichedAuth, c.executionCtx);
  await server.connect(transport);

  // Handle the request
  return transport.handleRequest(c.req.raw);
});

// Handle non-POST requests to /mcp
app.all("/mcp", (c) => {
  if (c.req.method === "OPTIONS") {
    return c.body(null, 204);
  }
  return c.text("Method Not Allowed", 405);
});

// 404 for unknown paths
app.all("*", (c) => {
  return c.text("Not Found", 404);
});

export default app;
