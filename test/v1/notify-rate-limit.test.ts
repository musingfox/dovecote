import { test, expect, mock, beforeEach, spyOn } from "bun:test";
import { Hono } from "hono";
import { createV1App } from "../../src/api-v1.js";
import type { Env } from "../../src/types.js";
import type { AuthCtx } from "../../src/auth/ctx.js";
import { checkRateLimit } from "../../src/auth/rate-limit.js";
import { MockKV } from "../helpers/mock-kv.js";

const AUTH: AuthCtx = {
  userId: "bearer-user",
  scopes: ["dovecote:notify"],
  authMethod: "api_token",
  ip: "1.2.3.4",
};

function makeServices() {
  return {
    sendNotification: mock(async (_env: any, _auth: any, _ctx: any, args: any) => ({
      success: true,
      channel: args.channel,
      messageId: "msg-ok",
    })),
    listChannels: mock(async () => []),
    issueToken: mock(async () => ({ token: "x", tokenId: "x", expiresAt: 0 })),
    revokeToken: mock(async () => ({ revoked: true })),
    checkRateLimit,
  };
}

function buildApp(auth: AuthCtx = AUTH) {
  const v1 = createV1App(makeServices() as any);
  const app = new Hono<{ Bindings: Env; Variables: { auth: AuthCtx } }>();
  app.use("/v1/*", async (c, next) => {
    c.set("auth", auth);
    await next();
  });
  app.route("/v1", v1);
  return app;
}

function buildEnv(rateLimit?: string): Env {
  return {
    OAUTH_KV: new MockKV() as any,
    HMAC_PEPPER: "test-pepper-32-characters-long",
    ...(rateLimit === undefined ? {} : { NOTIFY_RATE_LIMIT_PER_MINUTE: rateLimit }),
  };
}

function createMockExecutionContext() {
  const promises: Promise<any>[] = [];
  return {
    props: null,
    waitUntil: (p: Promise<any>) => promises.push(p),
    passThroughOnException: () => {},
  };
}

function notifyRequest() {
  return new Request("http://localhost/v1/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel: "ops", content: { text: "hello" } }),
  });
}

async function postNotify(app: ReturnType<typeof buildApp>, env: Env) {
  return app.fetch(notifyRequest(), env, createMockExecutionContext());
}

beforeEach(() => {
  mock.restore();
});

test("POST /v1/notify allows 60 requests by default, then returns 429 with Retry-After and audit", async () => {
  const auditSpy = spyOn(console, "log").mockImplementation(() => {});
  const app = buildApp();
  const env = buildEnv();

  for (let i = 0; i < 60; i++) {
    const res = await postNotify(app, env);
    expect(res.status).toBe(200);
  }

  const res = await postNotify(app, env);
  expect(res.status).toBe(429);
  expect(res.headers.get("Retry-After")).toBe("60");
  expect(await res.json()).toEqual({
    error: "rate_limited",
    error_description: "Too many requests",
  });

  const auditEntries = auditSpy.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === "string")
    .map((line) => JSON.parse(line));
  expect(auditEntries).toContainEqual(
    expect.objectContaining({
      event: "notify.send",
      reason: "rate_limited",
      ok: false,
      ip: "1.2.3.4",
      authMethod: "api_token",
      scope: "dovecote:notify",
    })
  );
});

test("POST /v1/notify honors NOTIFY_RATE_LIMIT_PER_MINUTE override", async () => {
  spyOn(console, "log").mockImplementation(() => {});
  const app = buildApp();
  const env = buildEnv("10");

  for (let i = 0; i < 10; i++) {
    const res = await postNotify(app, env);
    expect(res.status).toBe(200);
  }

  const res = await postNotify(app, env);
  expect(res.status).toBe(429);
  expect(res.headers.get("Retry-After")).toBe("60");
});

test("POST /v1/notify falls back to default limit for malformed NOTIFY_RATE_LIMIT_PER_MINUTE", async () => {
  spyOn(console, "log").mockImplementation(() => {});
  const app = buildApp();
  const env = buildEnv("not-a-number");

  for (let i = 0; i < 60; i++) {
    const res = await postNotify(app, env);
    expect(res.status).toBe(200);
  }

  const res = await postNotify(app, env);
  expect(res.status).toBe(429);
  expect(res.headers.get("Retry-After")).toBe("60");
});
