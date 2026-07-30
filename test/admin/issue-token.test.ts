import { test, expect } from "bun:test";
import app from "../../src/index.js";
import type { Env } from "../../src/types.js";
import { MockKV } from "../helpers/mock-kv.js";
import { createMockExecutionCtx } from "../helpers/mock-execution-ctx.js";

function makeEnv(): Env {
  const kv = new MockKV();
  return {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "test-pass",
    COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length",
    HMAC_PEPPER: "test-pepper",
    ADMIN_REVOKE_TOKEN: "admin-tok",
  } as Env;
}

test("admin-issue-token removal: POST /admin/issue-token with Bearer ADMIN_REVOKE_TOKEN and valid body returns 404 (AdminIssueTokenRemoved T1)", async () => {
  const env = makeEnv();
  const req = new Request("https://example.com/admin/issue-token", {
    method: "POST",
    headers: {
      Authorization: "Bearer admin-tok",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      userId: "alice",
      scopes: ["dovecote:notify"],
      expiresInDays: 30,
    }),
  });
  const res = await app.fetch(req, env, createMockExecutionCtx());
  expect(res.status).toBe(404);
});
