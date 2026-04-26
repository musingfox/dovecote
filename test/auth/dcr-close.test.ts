import { test, expect } from "bun:test";
import app from "../../src/index.js";
import type { Env } from "../../src/types.js";
import { MockKV } from "../helpers/mock-kv.js";

test("DCR closed: POST /mcp/register returns 4xx or 5xx", async () => {
  const kv = new MockKV();

  const env: Env = {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "test-pass",
    COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length",
    ADMIN_REVOKE_TOKEN: "tok",
  };

  const req = new Request("https://example.com/mcp/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_name: "test-client",
      redirect_uris: ["https://example.com/callback"],
    }),
  });

  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as any;
  const res = await app.fetch(req, env, ctx);

  // Should return error status (4xx or 5xx)
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.status).toBeLessThan(600);
});
