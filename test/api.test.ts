import { test, expect } from "bun:test";
import apiApp from "../src/api.js";
import type { Env } from "../src/types.js";
import { createMockExecutionCtx } from "./helpers/mock-execution-ctx";

const mockEnv: Env = {
  OAUTH_KV: {} as any,
  HMAC_PEPPER: "test-pepper",
};

// ChannelEnvBindingRemovedFromWorker T1: channels come from `channel:<id>` KV
// records, never from the environment. Nothing named *_INSTANCES may survive on
// a worker Env fixture, and a leftover fixture field is caught here.
//
// This does NOT guard the interface, and neither does `bun run typecheck`: adding
// the field back to `Env` in src/types.ts leaves tsc clean, because an unused
// optional property is not a type error (measured, not assumed). The guard that
// actually catches an interface-level reintroduction is
// test/removal/channel-env-surface.test.ts — "T1: no tracked file mentions either
// channel env identifier" — which scans every tracked file for the identifiers.
test("the worker Env carries no channel-configuration binding", () => {
  for (const key of Object.keys(mockEnv)) {
    expect(key).not.toMatch(/_INSTANCES$/);
  }
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

  const ctx = createMockExecutionCtx({ userId: "operator", scopes: ["dovecote:notify"] });
  const res = await apiApp.fetch(req, mockEnv, ctx as any);
  expect(res.status).toBe(200);

  const text = await res.text();
  expect(text).toContain("dovecote-mcp-server");
});

test("GET /mcp returns 405 Method Not Allowed", async () => {
  const req = new Request("https://example.com/mcp", {
    method: "GET",
  });

  const ctx = createMockExecutionCtx(null);
  const res = await apiApp.fetch(req, mockEnv, ctx as any);
  expect(res.status).toBe(405);
  expect(await res.text()).toBe("Method Not Allowed");
});

test("OPTIONS /mcp returns 204", async () => {
  const req = new Request("https://example.com/mcp", {
    method: "OPTIONS",
  });

  const ctx = createMockExecutionCtx(null);
  const res = await apiApp.fetch(req, mockEnv, ctx as any);
  expect(res.status).toBe(204);
});

test("GET /unknown returns 404", async () => {
  const req = new Request("https://example.com/unknown");
  const ctx = createMockExecutionCtx(null);
  const res = await apiApp.fetch(req, mockEnv, ctx as any);

  expect(res.status).toBe(404);
  expect(await res.text()).toBe("Not Found");
});
