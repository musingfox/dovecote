import { describe, it, expect } from "bun:test";
import { createMCPServer } from "../src/server";
import app from "../src/index";
import type { Env } from "../src/types";

const mockEnv: Env = {
  MCP_AUTH_TOKEN: "test-token-123",
};

describe("MCP Server Factory", () => {
  it("createMCPServer returns McpServer instance with correct metadata", () => {
    const server = createMCPServer(mockEnv);

    expect((server as any).server._serverInfo.name).toBe("dovecote-mcp-server");
    expect((server as any).server._serverInfo.version).toBe("1.0.0");
  });
});

describe("Health Endpoint", () => {
  it("GET /health returns status 200 with ok status and ISO8601 timestamp", async () => {
    const req = new Request("http://localhost/health");
    const res = await app.fetch(req, mockEnv);

    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.status).toBe("ok");
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe("MCP Transport Endpoint", () => {
  it("POST /mcp with initialize returns jsonrpc result with serverInfo", async () => {
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        Authorization: "Bearer test-token-123",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: {
            name: "test",
            version: "1.0.0",
          },
        },
        id: 1,
      }),
    });

    const res = await app.fetch(req, mockEnv);
    expect(res.status).toBe(200);

    const body = await res.text();
    expect(body).toContain("jsonrpc");
    expect(body).toContain("serverInfo");
  });

  it("OPTIONS /mcp returns 204 with CORS headers", async () => {
    const req = new Request("http://localhost/mcp", {
      method: "OPTIONS",
    });

    const res = await app.fetch(req, mockEnv);
    expect(res.status).toBe(204);

    const allowMethods = res.headers.get("Access-Control-Allow-Methods");
    expect(allowMethods).toContain("POST");
  });
});

describe("Bearer Auth", () => {
  it("POST /mcp with valid token returns 200", async () => {
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer test-token-123",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
        id: 1,
      }),
    });
    const res = await app.fetch(req, mockEnv);
    expect(res.status).toBe(200);
  });

  it("POST /mcp without auth returns 401", async () => {
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {},
        id: 1,
      }),
    });
    const res = await app.fetch(req, mockEnv);
    expect(res.status).toBe(401);
  });

  it("POST /mcp with wrong token returns 401", async () => {
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {},
        id: 1,
      }),
    });
    const res = await app.fetch(req, mockEnv);
    expect(res.status).toBe(401);
  });

  it("GET /health does not require auth", async () => {
    const req = new Request("http://localhost/health");
    const res = await app.fetch(req, mockEnv);
    expect(res.status).toBe(200);
  });
});
