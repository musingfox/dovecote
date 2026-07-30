import { test, expect } from "bun:test";
import app from "../../src/index.js";
import type { Env } from "../../src/types.js";
import { MockKV } from "../helpers/mock-kv.js";
import { createMockExecutionCtx } from "../helpers/mock-execution-ctx.js";

function makeEnv(overrides: Partial<Env> = {}): Env {
  const kv = new MockKV();
  return {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "test-pass",
    COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length",
    HMAC_PEPPER: "test-pepper",
    ADMIN_REVOKE_TOKEN: "admin-tok",
    ...overrides,
  } as Env;
}

test("removal: POST /admin/issue-token with Bearer ADMIN_REVOKE_TOKEN returns 404 (AdminIssueTokenRemoved T1)", async () => {
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
    }),
  });
  const res = await app.fetch(req, env, createMockExecutionCtx());
  expect(res.status).toBe(404);
});

// CfAccessOidcRemoved T1-T3 (surface through main app)
test("removal: POST /v1/auth/exchange-oidc without auth -> 401 (CfAccessOidcRemoved T1)", async () => {
  const env = makeEnv();
  const req = new Request("https://example.com/v1/auth/exchange-oidc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id_token: "x" }),
  });
  const res = await app.fetch(req, env, createMockExecutionCtx());
  expect(res.status).toBe(401);
});

test("removal: GET /oidc/callback -> 404 (T2)", async () => {
  const env = makeEnv();
  const req = new Request("https://example.com/oidc/callback?code=x&state=y");
  const res = await app.fetch(req, env, createMockExecutionCtx());
  expect(res.status).toBe(404);
});

test("removal: GET /oidc/redirect -> 404 (T3)", async () => {
  const env = makeEnv();
  const req = new Request("https://example.com/oidc/redirect?response_type=code&client_id=c");
  const res = await app.fetch(req, env, createMockExecutionCtx());
  expect(res.status).toBe(404);
});
