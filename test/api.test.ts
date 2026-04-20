import { test, expect } from "bun:test";
import apiApp from "../src/api.js";
import type { Env } from "../src/types.js";

const mockEnv: Env = {
  MCP_AUTH_TOKEN: "test-token",
  OAUTH_KV: {} as any,
  OAUTH_PASSWORD: "test-password",
  COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length",
  TELEGRAM_INSTANCES: undefined,
  DISCORD_INSTANCES: undefined,
};

test("GET /health returns 200 with status ok", async () => {
  const req = new Request("https://example.com/health");
  const res = await apiApp.fetch(req, mockEnv);

  expect(res.status).toBe(200);

  const json = await res.json();
  expect(json.status).toBe("ok");
  expect(json.timestamp).toBeTruthy();
  // Verify timestamp is ISO8601 format
  expect(() => new Date(json.timestamp)).not.toThrow();
});

test("POST /mcp with MCP initialize returns 200", async () => {
  const initializeRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "test-client",
        version: "1.0.0",
      },
    },
  };

  const req = new Request("https://example.com/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(initializeRequest),
  });

  const res = await apiApp.fetch(req, mockEnv);
  expect(res.status).toBe(200);

  const text = await res.text();
  expect(text).toContain("dovecote-mcp-server");
});

test("GET /mcp returns 405 Method Not Allowed", async () => {
  const req = new Request("https://example.com/mcp", {
    method: "GET",
  });

  const res = await apiApp.fetch(req, mockEnv);
  expect(res.status).toBe(405);
  expect(await res.text()).toBe("Method Not Allowed");
});

test("OPTIONS /mcp returns 204", async () => {
  const req = new Request("https://example.com/mcp", {
    method: "OPTIONS",
  });

  const res = await apiApp.fetch(req, mockEnv);
  expect(res.status).toBe(204);
});

test("GET /unknown returns 404", async () => {
  const req = new Request("https://example.com/unknown");
  const res = await apiApp.fetch(req, mockEnv);

  expect(res.status).toBe(404);
  expect(await res.text()).toBe("Not Found");
});
