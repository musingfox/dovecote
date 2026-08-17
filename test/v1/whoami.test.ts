import { test, expect } from "bun:test";
import { Hono } from "hono";
import { createV1App, type V1Services } from "../../src/api-v1.js";
import type { Env } from "../../src/types.js";
import { bearerMiddleware } from "../../src/auth/bearer.js";
import { MockKV } from "../helpers/mock-kv.js";
import { createMockExecutionCtx } from "../helpers/mock-execution-ctx.js";
import type { AuthCtx } from "../../src/auth/ctx.js";
import type { ExecutionContext } from "@cloudflare/workers-types";

function buildTestEnv(): Env {
  const kv = new MockKV();
  return {
    OAUTH_KV: kv,
    HMAC_PEPPER: "test-pepper-32-characters-long",
  } as unknown as Env;
}

// Matches token-list.test.ts buildApp style for v1 route tests (injects auth ctx, bypasses bearer)
function buildApp(auth: AuthCtx | null, servicesOverrides: Record<string, unknown> = {}) {
  const baseServices = {
    sendNotification: async () => ({ success: true, channel: "test" }),
    listChannels: async () => [],
    issueToken: async () => ({ token: "x", tokenId: "x", expiresAt: 0 }),
    revokeToken: async () => ({ revoked: true }),
    checkRateLimit: async () => ({ allowed: true, current: 0 }),
    ...servicesOverrides,
  } satisfies V1Services;
  const v1 = createV1App(baseServices);
  const app = new Hono<{ Bindings: Env; Variables: { auth: AuthCtx } } >();
  app.use("/v1/*", async (c, next) => {
    if (auth) c.set("auth", auth);
    await next();
  });
  app.route("/v1", v1);
  return { app };
}

function createMockExecutionContext() {
  return createMockExecutionCtx(null) as unknown as ExecutionContext;
}

const U1_AUTH: AuthCtx = {
  userId: "u1",
  scopes: ["dovecote:notify"],
  authMethod: "api_token",
  ip: "1.2.3.4",
  tokenId: "t1",
};

// T2 uses real bearer middleware + no header to hit 401 from middleware (no shim)
function buildBearerApp() {
  const v1 = createV1App({
    sendNotification: async () => ({ success: true, channel: "test" }),
    listChannels: async () => [],
    issueToken: async () => ({ token: "x", tokenId: "x", expiresAt: 0 }),
    revokeToken: async () => ({ revoked: true }),
    checkRateLimit: async () => ({ allowed: true, current: 0 }),
  } satisfies V1Services);
  const app = new Hono<{ Bindings: Env; Variables: { auth: AuthCtx } } >();
  app.use("/v1/*", bearerMiddleware);
  app.route("/v1", v1);
  return app;
}

test("WhoamiEndpoint T1: seeded token u1/t1/[dovecote:notify]/expiresAt=1750000000000; GET /v1/auth/whoami with that bearer -> 200 with exact body", async () => {
  const env = buildTestEnv();
  const meta = {
    tokenId: "t1",
    userId: "u1",
    scopes: ["dovecote:notify"],
    hash: "seedhash",
    createdAt: Date.now() - 1000,
    expiresAt: 1750000000000,
  };
  const services = {
    getTokenMetadataByTokenId: async (_tid: string, _e: Env) => meta,
  };
  const { app } = buildApp(U1_AUTH, services);

  const res = await app.fetch(
    new Request("http://localhost/v1/auth/whoami"),
    env,
    createMockExecutionContext()
  );
  expect(res.status).toBe(200);
  const body: unknown = await res.json();
  expect(body).toEqual({
    userId: "u1",
    tokenId: "t1",
    scopes: ["dovecote:notify"],
    expiresAt: 1750000000000,
  });
});

test("WhoamiEndpoint errors: canonical apitoken record missing -> 500 internal_error (not 401)", async () => {
  const env = buildTestEnv();
  const { app } = buildApp(U1_AUTH, {
    getTokenMetadataByTokenId: async () => null,
  });

  const res = await app.fetch(
    new Request("http://localhost/v1/auth/whoami"),
    env,
    createMockExecutionContext()
  );
  expect(res.status).toBe(500);
  const body = (await res.json()) as any;
  expect(body.error).toBe("internal_error");
});

test("WhoamiEndpoint T2: GET /v1/auth/whoami without Authorization -> expect 401", async () => {
  const env = buildTestEnv();
  const app = buildBearerApp();

  const req = new Request("http://localhost/v1/auth/whoami");
  const res = await app.fetch(req, env, createMockExecutionContext());

  expect(res.status).toBe(401);
});
