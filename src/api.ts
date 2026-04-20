import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types.js";
import { createMCPServer } from "./server.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

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

// Health endpoint
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

// MCP transport endpoint - stateless mode
app.post("/mcp", async (c) => {
  // Create new transport and server for each request (stateless mode)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  const server = createMCPServer(c.env);
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
