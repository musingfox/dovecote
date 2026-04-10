import { Hono } from "hono";
import { cors } from "hono/cors";
import { bearerAuth } from "hono/bearer-auth";
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

// Bearer auth middleware for MCP endpoints (skip OPTIONS)
app.use("/mcp", async (c, next) => {
  if (c.req.method === "OPTIONS") {
    return next();
  }
  const auth = bearerAuth({
    verifyToken: (token, c) => token === c.env.MCP_AUTH_TOKEN,
  });
  return auth(c, next);
});

// Health endpoint
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

// MCP transport endpoint - stateless mode
app.all("/mcp", async (c) => {
  const method = c.req.method;

  // Allow GET, POST, DELETE, OPTIONS
  if (!["GET", "POST", "DELETE", "OPTIONS"].includes(method)) {
    return c.text("Method Not Allowed", 405);
  }

  // Handle OPTIONS (preflight)
  if (method === "OPTIONS") {
    return c.body(null, 204);
  }

  // Create new transport and server for each request (stateless mode)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  const server = createMCPServer(c.env);
  await server.connect(transport);

  // Handle the request
  return transport.handleRequest(c.req.raw);
});

export default app;
