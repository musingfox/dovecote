import { test, expect, mock, beforeEach } from "bun:test";
import { Hono } from "hono";
import { createV1App, type V1Services } from "../../src/api-v1.js";
import { listChannels as realListChannels } from "../../src/services/channels.js";
import type { Env } from "../../src/types.js";
import type { AuthCtx } from "../../src/auth/ctx.js";
import { MockKV } from "../helpers/mock-kv.js";
import { ScopeError, NotFoundError, UpstreamError } from "../../src/services/errors.js";

// Fresh service mocks per test via factory injection — exercises the real
// createV1App() router from src/api-v1.ts.
function makeServices(overrides: {
  sendNotification?: (...args: any[]) => any;
  listChannels?: (...args: any[]) => any;
  checkRateLimit?: (...args: any[]) => any;
} = {}) {
  return {
    sendNotification: mock(
      overrides.sendNotification ??
        (async (_env: any, _auth: any, _ctx: any, args: any) => ({
          success: true,
          channel: args.channel,
          messageId: "msg-default",
        }))
    ),
    listChannels: mock(overrides.listChannels ?? (async (_env: any, _auth: any) => [] as any[])),
    checkRateLimit: mock(
      overrides.checkRateLimit ??
        (async (_kv: any, _ip: string, _namespace: string, _limit?: number) => ({
          allowed: true,
          current: 1,
        }))
    ),
  };
}

function buildApp(auth: AuthCtx | null, services = makeServices()) {
  const v1 = createV1App(services as any);
  const app = new Hono<{ Bindings: Env; Variables: { auth: AuthCtx } }>();
  app.use("/v1/*", async (c, next) => {
    if (auth) c.set("auth", auth);
    await next();
  });
  app.route("/v1", v1);
  return { app, services };
}

function buildTestEnv(): Env {
  const kv = new MockKV();
  return {
    OAUTH_KV: kv as any,
    HMAC_PEPPER: "test-pepper",
  };
}

// Channels live in KV under `channel:<service>-<id>`; there is no env-var source.
async function buildKvChannelEnv(
  records: Record<string, unknown> = {}
): Promise<Env> {
  const kv = new MockKV();
  for (const [key, record] of Object.entries(records)) {
    await kv.put(key, JSON.stringify(record));
  }
  return {
    OAUTH_KV: kv as any,
    HMAC_PEPPER: "test-pepper",
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

const NOTIFY_AUTH: AuthCtx = {
  userId: "user-1",
  scopes: ["dovecote:notify"],
  authMethod: "api_token",
  ip: "127.0.0.1",
};
const NO_SCOPE_AUTH: AuthCtx = {
  userId: "user-1",
  scopes: [],
  authMethod: "api_token",
  ip: "127.0.0.1",
};

beforeEach(() => {
  mock.restore();
});

// ============================================================
// C2.4.a — POST /v1/notify
// ============================================================

test("C2.4.a - POST /v1/notify success with valid bearer + scope", async () => {
  const { app } = buildApp(
    NOTIFY_AUTH,
    makeServices({
      sendNotification: async (_env: any, _auth: any, _ctx: any, args: any) => ({
        success: true,
        channel: args.channel,
        messageId: "msg-999",
      }),
    })
  );
  const env = buildTestEnv();

  const req = new Request("http://localhost/v1/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel: "telegram", content: { text: "hi" } }),
  });
  const res = await app.fetch(req, env, createMockExecutionContext());
  expect(res.status).toBe(200);

  const body = (await res.json()) as any;
  expect(body.success).toBe(true);
  expect(body.channel).toBe("telegram");
  expect(body.messageId).toBe("msg-999");
});

test("C2.4.a - POST /v1/notify 403 forbidden (missing scope, ScopeError)", async () => {
  const { app } = buildApp(
    NO_SCOPE_AUTH,
    makeServices({
      sendNotification: async () => {
        throw new ScopeError("dovecote:notify");
      },
    })
  );
  const env = buildTestEnv();

  const req = new Request("http://localhost/v1/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel: "telegram", content: { text: "hi" } }),
  });
  const res = await app.fetch(req, env, createMockExecutionContext());
  expect(res.status).toBe(403);

  const body = (await res.json()) as any;
  expect(body.error).toBe("forbidden");
  expect(body.error_description).toContain("dovecote:notify");
});

test("C2.4.a - POST /v1/notify 400 invalid_request (zod fail - empty content)", async () => {
  const { app } = buildApp(NOTIFY_AUTH);
  const env = buildTestEnv();

  const req = new Request("http://localhost/v1/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel: "telegram", content: {} }),
  });
  const res = await app.fetch(req, env, createMockExecutionContext());
  expect(res.status).toBe(400);

  const body = (await res.json()) as any;
  expect(body.error).toBe("invalid_request");
  expect(body.error_description).toContain("At least one of text, embed, or attachment");
});

test("C2.4.a - POST /v1/notify 404 not_found (NotFoundError)", async () => {
  const { app } = buildApp(
    NOTIFY_AUTH,
    makeServices({
      sendNotification: async () => {
        throw new NotFoundError("Unknown channel");
      },
    })
  );
  const env = buildTestEnv();

  const req = new Request("http://localhost/v1/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel: "unknown-channel", content: { text: "hi" } }),
  });
  const res = await app.fetch(req, env, createMockExecutionContext());
  expect(res.status).toBe(404);

  const body = (await res.json()) as any;
  expect(body.error).toBe("not_found");
  expect(body.error_description).toBe("Unknown channel");
});

test("C2.4.a - POST /v1/notify 404 not_found (SendResult.success=false)", async () => {
  const { app } = buildApp(
    NOTIFY_AUTH,
    makeServices({
      sendNotification: async (_env: any, _auth: any, _ctx: any, args: any) => ({
        success: false,
        channel: args.channel,
        error: "Unknown channel",
      }),
    })
  );
  const env = buildTestEnv();

  const req = new Request("http://localhost/v1/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel: "unknown-channel", content: { text: "hi" } }),
  });
  const res = await app.fetch(req, env, createMockExecutionContext());
  expect(res.status).toBe(404);

  const body = (await res.json()) as any;
  expect(body.error).toBe("not_found");
  expect(body.error_description).toBe("Unknown channel");
});

test("C2.4.a - POST /v1/notify 502 upstream_error (UpstreamError)", async () => {
  const { app } = buildApp(
    NOTIFY_AUTH,
    makeServices({
      sendNotification: async () => {
        throw new UpstreamError("Discord 503");
      },
    })
  );
  const env = buildTestEnv();

  const req = new Request("http://localhost/v1/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel: "telegram", content: { text: "hi" } }),
  });
  const res = await app.fetch(req, env, createMockExecutionContext());
  expect(res.status).toBe(502);

  const body = (await res.json()) as any;
  expect(body.error).toBe("upstream_error");
  expect(body.error_description).toBe("Discord 503");
});

test("C2.4.a - POST /v1/notify 500 internal_error (generic Error)", async () => {
  const { app } = buildApp(
    NOTIFY_AUTH,
    makeServices({
      sendNotification: async () => {
        throw new Error("kaboom");
      },
    })
  );
  const env = buildTestEnv();

  const req = new Request("http://localhost/v1/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel: "telegram", content: { text: "hi" } }),
  });
  const res = await app.fetch(req, env, createMockExecutionContext());
  expect(res.status).toBe(500);

  const body = (await res.json()) as any;
  expect(body.error).toBe("internal_error");
});

test("C2.4.a - POST /v1/notify 400 invalid_request (malformed JSON)", async () => {
  const { app } = buildApp(NOTIFY_AUTH);
  const env = buildTestEnv();

  const req = new Request("http://localhost/v1/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "not valid json",
  });
  const res = await app.fetch(req, env, createMockExecutionContext());
  expect(res.status).toBe(400);

  const body = (await res.json()) as any;
  expect(body.error).toBe("invalid_request");
});

test("C2.4.a - POST /v1/notify 400 invalid_request (non-string channel)", async () => {
  const { app } = buildApp(NOTIFY_AUTH);
  const env = buildTestEnv();

  const req = new Request("http://localhost/v1/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel: 123, content: { text: "hi" } }),
  });
  const res = await app.fetch(req, env, createMockExecutionContext());
  expect(res.status).toBe(400);

  const body = (await res.json()) as any;
  expect(body.error).toBe("invalid_request");
});

// ============================================================
// C2.4.b — GET /v1/channels
// ============================================================

test("C2.4.b - GET /v1/channels success with scope, no channels configured", async () => {
  const { app } = buildApp(
    NOTIFY_AUTH,
    makeServices({ listChannels: async () => [] })
  );
  const env = buildTestEnv();

  const req = new Request("http://localhost/v1/channels");
  const res = await app.fetch(req, env, createMockExecutionContext());
  expect(res.status).toBe(200);

  const body = (await res.json()) as any;
  expect(body.channels).toEqual([]);
});

test("C2.4.b - GET /v1/channels success with scope, two channels configured", async () => {
  const { app } = buildApp(
    NOTIFY_AUTH,
    makeServices({
      listChannels: async () => [
        { id: "discord-main", name: "Main Discord", enabled: true, service: "discord" },
        { id: "discord-test", name: "Test Discord", enabled: true, service: "discord" },
      ],
    })
  );
  const env = buildTestEnv();

  const req = new Request("http://localhost/v1/channels");
  const res = await app.fetch(req, env, createMockExecutionContext());
  expect(res.status).toBe(200);

  const body = (await res.json()) as any;
  expect(body.channels.length).toBe(2);
  expect(body.channels[0]).toMatchObject({
    id: "discord-main",
    name: expect.any(String),
    service: "discord",
  });
  expect(body.channels[1]).toMatchObject({
    id: "discord-test",
    name: expect.any(String),
    service: "discord",
  });
});

// ChannelsEndpointAwaitsAsyncRegistry — the list now comes from KV, awaited.

test("channels/T1 - GET /v1/channels reports the channels stored in KV", async () => {
  const { app } = buildApp(
    NOTIFY_AUTH,
    makeServices({ listChannels: realListChannels })
  );
  const env = await buildKvChannelEnv({
    "channel:telegram-default": {
      service: "telegram",
      id: "default",
      botToken: "bot123:token",
      chatId: "-100123456",
    },
  });

  const req = new Request("http://localhost/v1/channels");
  const res = await app.fetch(req, env, createMockExecutionContext());
  expect(res.status).toBe(200);

  expect(await res.json()).toEqual({
    channels: [
      {
        id: "telegram-default",
        name: "Telegram (default)",
        enabled: true,
        service: "telegram",
      },
    ],
  });
});

test("channels/T2 - GET /v1/channels returns an empty list when KV holds no channels", async () => {
  const { app } = buildApp(
    NOTIFY_AUTH,
    makeServices({ listChannels: realListChannels })
  );
  const env = await buildKvChannelEnv();

  const req = new Request("http://localhost/v1/channels");
  const res = await app.fetch(req, env, createMockExecutionContext());
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ channels: [] });
});

test("channels/T3 - GET /v1/channels 403 without dovecote:notify never calls listChannels", async () => {
  // The stub resolves normally: a 403 can only come from the route's own gate,
  // and the KV listing must never be reached by an unauthorised caller.
  const { app, services } = buildApp(
    NO_SCOPE_AUTH,
    makeServices({ listChannels: async () => [] })
  );
  const env = await buildKvChannelEnv({
    "channel:telegram-default": {
      service: "telegram",
      id: "default",
      botToken: "bot123:token",
      chatId: "-100123456",
    },
  });

  const req = new Request("http://localhost/v1/channels");
  const res = await app.fetch(req, env, createMockExecutionContext());
  expect(res.status).toBe(403);

  const body = (await res.json()) as any;
  expect(body.error).toBe("forbidden");
  expect(body.error_description).toContain("dovecote:notify");
  expect(services.listChannels).not.toHaveBeenCalled();
});

test("channels/T4 - GET /v1/channels 500 when the registry promise rejects", async () => {
  const { app } = buildApp(
    NOTIFY_AUTH,
    makeServices({
      listChannels: async () => {
        throw new Error("KV unavailable");
      },
    })
  );
  const env = buildTestEnv();

  const req = new Request("http://localhost/v1/channels");
  const res = await app.fetch(req, env, createMockExecutionContext());
  // Without the await the rejected promise would serialise as `{}` with a 200.
  expect(res.status).toBe(500);

  const body = (await res.json()) as any;
  expect(body.error).toBe("internal_error");
});

test("channels/T6 - V1Services.listChannels is declared async", () => {
  // Compile-time contract, asserted where the v1 mock files consume the type:
  // the async mock style used by all six of them is assignable...
  const asyncSlot: V1Services["listChannels"] = makeServices().listChannels;
  // ...and the real service satisfies the slot without widening.
  const realSlot: V1Services["listChannels"] = realListChannels;
  // @ts-expect-error listChannels must be (env, auth) => Promise<ChannelConfig[]>, not a sync array
  const syncSlot: V1Services["listChannels"] = (_env: Env, _auth: AuthCtx) => [];

  expect(typeof asyncSlot).toBe("function");
  expect(typeof realSlot).toBe("function");
  expect(typeof syncSlot).toBe("function");
});

test("C2.4.b - GET /v1/channels 403 forbidden (missing scope)", async () => {
  const { app } = buildApp(
    NO_SCOPE_AUTH,
    makeServices({
      listChannels: async () => {
        throw new ScopeError("dovecote:notify");
      },
    })
  );
  const env = buildTestEnv();

  const req = new Request("http://localhost/v1/channels");
  const res = await app.fetch(req, env, createMockExecutionContext());
  expect(res.status).toBe(403);

  const body = (await res.json()) as any;
  expect(body.error).toBe("forbidden");
  expect(body.error_description).toContain("dovecote:notify");
});
