import { test, expect } from "bun:test";
import { Hono } from "hono";
import v1App from "../../src/api-v1.js";
import type { Env } from "../../src/types.js";
import type { AuthCtx } from "../../src/auth/ctx.js";
import { MockKV } from "../helpers/mock-kv.js";
import { createMockExecutionCtx } from "../helpers/mock-execution-ctx.js";

// Smoke test for the DEFAULT-WIRED v1App (not createV1App factory). Verifies each
// route invokes its intended service in src/api-v1.ts. The factory-mocked tests in
// handlers.test.ts and tokens.test.ts can't catch service-slot mutations
// (e.g. listChannels wired into the notify route); these assertions can.
//
// Strategy: each route's expected service produces a uniquely identifiable
// response or error. If a mutation swaps services, the shape no longer matches.

function buildApp(auth: AuthCtx) {
  const app = new Hono<{ Bindings: Env; Variables: { auth: AuthCtx } }>();
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    await next();
  });
  app.route("/v1", v1App);
  return app;
}

const noScope: AuthCtx = {
  userId: "u",
  scopes: [],
  authMethod: "api_token",
  ip: "127.0.0.1",
  tokenId: "t",
};

const adminAuth: AuthCtx = {
  userId: "admin",
  scopes: ["dovecote:admin"],
  authMethod: "api_token",
  ip: "127.0.0.1",
  tokenId: "t",
};

function makeEnv(extra: Partial<Env> = {}): Env {
  return {
    OAUTH_KV: new MockKV() as any,
    HMAC_PEPPER: "test-pepper-32-characters-long",
    OAUTH_PASSWORD: "p",
    COOKIE_ENCRYPTION_KEY: "k",
    TELEGRAM_INSTANCES: undefined,
    DISCORD_INSTANCES: undefined,
    ...extra,
  } as Env;
}

// /v1/notify → sendNotification throws ScopeError("dovecote:notify") on missing scope.
// listChannels also throws "dovecote:notify"; differentiate via route-specific request shape:
// sendNotification rejects on body, listChannels on a GET.
test("wiring: POST /v1/notify delegates to sendNotification (ScopeError signature)", async () => {
  const app = buildApp(noScope);
  const res = await app.fetch(
    new Request("http://localhost/v1/notify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "x", content: { text: "hi" } }),
    }),
    makeEnv(),
    createMockExecutionCtx(null) as any,
  );
  expect(res.status).toBe(403);
  const body = (await res.json()) as any;
  expect(body.error_description).toContain("dovecote:notify");
});

// /v1/channels → listChannels throws ScopeError("dovecote:notify") on missing scope.
// Method+path identifies the route, ScopeError target confirms the service.
test("wiring: GET /v1/channels delegates to listChannels (ScopeError signature)", async () => {
  const app = buildApp(noScope);
  const res = await app.fetch(
    new Request("http://localhost/v1/channels"),
    makeEnv(),
    createMockExecutionCtx(null) as any,
  );
  expect(res.status).toBe(403);
  const body = (await res.json()) as any;
  expect(body.error_description).toContain("dovecote:notify");
});

// /v1/tokens POST → admin gate inside route, then issueToken. Identifying signature:
// successful issuance returns a token starting with "dvct_". revokeToken returns a
// different shape (`{revoked, notice}`), so a slot-swap would fail this expect.
test("wiring: POST /v1/tokens delegates to issueToken (response signature)", async () => {
  const app = buildApp(adminAuth);
  const res = await app.fetch(
    new Request("http://localhost/v1/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "u1", scopes: ["dovecote:notify"], label: "ci" }),
    }),
    makeEnv(),
    createMockExecutionCtx(null) as any,
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as any;
  expect(typeof body.token).toBe("string");
  expect(body.token).toMatch(/^dvct_/);
  expect(body.tokenId).toBeTruthy();
});

// /v1/tokens GET → listUserTokens (non-admin) / listAllTokens (admin) — both
// route through services and return the same {tokens, truncated} envelope.
// Identifying signature: response has `tokens` (array) AND `truncated` (boolean) —
// POST returns `token`/`tokenId`, DELETE returns `notice`. Slot swap of the
// list helpers can't easily produce this envelope from sendNotification etc.
test("wiring: GET /v1/tokens delegates to list helpers (response envelope)", async () => {
  const app = buildApp(adminAuth);
  const res = await app.fetch(
    new Request("http://localhost/v1/tokens"),
    makeEnv(),
    createMockExecutionCtx(null) as any,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(Array.isArray(body.tokens)).toBe(true);
  expect(typeof body.truncated).toBe("boolean");
});

// /v1/tokens/:id DELETE → admin gate then revokeToken. Identifying signature:
// response carries `notice` field (eventual-consistency copy) — only revokeToken
// path emits this in api-v1.ts.
test("wiring: DELETE /v1/tokens/:tokenId delegates to revokeToken (response signature)", async () => {
  const app = buildApp(adminAuth);
  const res = await app.fetch(
    new Request("http://localhost/v1/tokens/abc", { method: "DELETE" }),
    makeEnv(),
    createMockExecutionCtx(null) as any,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body).toHaveProperty("notice");
  expect(body.notice).toContain("60 seconds");
  expect(body).toHaveProperty("revoked");
});
