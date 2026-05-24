import { test, expect, mock, beforeEach, spyOn } from "bun:test";
import { Hono } from "hono";
import { createAuthExchangeDeviceApp } from "../../src/auth-exchange-device.js";
import type { Env } from "../../src/types.js";
import { MockKV } from "../helpers/mock-kv.js";
import { MissingPepperError, InvalidScopeError } from "../../src/auth/api-token.js";
import type { DeviceRecord } from "../../src/contracts/devices.js";

const GRANT = "urn:ietf:params:oauth:grant-type:device_code";

function makeServices(overrides: { checkRateLimit?: any; issueToken?: any } = {}) {
  return {
    issueToken:
      overrides.issueToken ??
      mock(async () => ({
        token: "dvct_" + "z".repeat(32),
        tokenId: "tid_xyz",
        expiresAt: Date.now() + 7_776_000_000,
      })),
    checkRateLimit:
      overrides.checkRateLimit ??
      mock(async () => ({ allowed: true, current: 1 })),
  };
}

function buildEnv(opts: { hmacPepper?: string } = {}): Env {
  return {
    OAUTH_KV: new MockKV() as any,
    OAUTH_PASSWORD: "test",
    COOKIE_ENCRYPTION_KEY: "x".repeat(32),
    HMAC_PEPPER: opts.hmacPepper ?? "pepper",
  };
}

function execCtx() {
  return {
    waitUntil: (_p: Promise<any>) => {},
    passThroughOnException: () => {},
  } as any;
}

function buildApp(services = makeServices()) {
  const root = new Hono<{ Bindings: Env }>();
  root.route("/", createAuthExchangeDeviceApp(services as any));
  return { root, services };
}

function req(body: unknown) {
  return new Request("http://localhost/v1/auth/exchange-device", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seed(
  env: Env,
  deviceCode: string,
  record: DeviceRecord,
): Promise<void> {
  await (env.OAUTH_KV as any).put(`device:${deviceCode}`, JSON.stringify(record), {
    expirationTtl: 600,
  });
}

beforeEach(() => {
  mock.restore();
});

test("poll within interval → 400 slow_down with bumped interval", async () => {
  const env = buildEnv();
  const { root } = buildApp();
  const now = Date.now();
  await seed(env, "DC1", {
    status: "pending",
    clientId: "cli",
    requestedScopes: [],
    intervalSec: 5,
    lastPollMs: now - 100, // far inside the 5s interval
    createdAt: now - 1000,
    expiresAt: now + 599_000,
    userCode: "AAAA-BBBB",
  });
  const res = await root.fetch(
    req({ grant_type: GRANT, device_code: "DC1" }),
    env,
    execCtx(),
  );
  expect(res.status).toBe(400);
  const body = (await res.json()) as any;
  expect(body.error).toBe("slow_down");
  expect(body.interval).toBe(10);
  const stored = await (env.OAUTH_KV as any).get("device:DC1", "json");
  expect(stored.intervalSec).toBe(10);
});

test("poll after interval, still pending → 400 authorization_pending", async () => {
  const env = buildEnv();
  const { root } = buildApp();
  const now = Date.now();
  await seed(env, "DC2", {
    status: "pending",
    clientId: "cli",
    requestedScopes: [],
    intervalSec: 5,
    lastPollMs: now - 10_000,
    createdAt: now - 20_000,
    expiresAt: now + 599_000,
    userCode: "AAAA-BBBB",
  });
  const res = await root.fetch(
    req({ grant_type: GRANT, device_code: "DC2" }),
    env,
    execCtx(),
  );
  expect(res.status).toBe(400);
  const body = (await res.json()) as any;
  expect(body.error).toBe("authorization_pending");
  const stored = await (env.OAUTH_KV as any).get("device:DC2", "json");
  expect(stored.intervalSec).toBe(5);
});

test("first poll on pending (lastPollMs=0) → authorization_pending, NOT slow_down", async () => {
  const env = buildEnv();
  const { root } = buildApp();
  const now = Date.now();
  await seed(env, "DC2b", {
    status: "pending",
    clientId: "cli",
    requestedScopes: [],
    intervalSec: 5,
    lastPollMs: 0,
    createdAt: now,
    expiresAt: now + 600_000,
    userCode: "AAAA-BBBB",
  });
  const res = await root.fetch(
    req({ grant_type: GRANT, device_code: "DC2b" }),
    env,
    execCtx(),
  );
  const body = (await res.json()) as any;
  expect(body.error).toBe("authorization_pending");
});

test("approved record → 201 dvct_* token; record rewritten to consumed", async () => {
  const env = buildEnv();
  const { root, services } = buildApp();
  const now = Date.now();
  await seed(env, "DCA", {
    status: "approved",
    clientId: "cli",
    requestedScopes: ["dovecote:notify"],
    intervalSec: 5,
    lastPollMs: 0,
    createdAt: now - 5000,
    expiresAt: now + 595_000,
    userCode: "AAAA-BBBB",
    userId: "alice",
    scopes: ["dovecote:notify"],
  });
  const res = await root.fetch(
    req({ grant_type: GRANT, device_code: "DCA" }),
    env,
    execCtx(),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as any;
  expect(body.token).toMatch(/^dvct_/);
  expect(body.userId).toBe("alice");
  expect(services.issueToken).toHaveBeenCalledTimes(1);

  const stored = await (env.OAUTH_KV as any).get("device:DCA", "json");
  expect(stored.status).toBe("consumed");
});

test("second poll on consumed → 400 expired_token", async () => {
  const env = buildEnv();
  const { root } = buildApp();
  const now = Date.now();
  await seed(env, "DCA2", {
    status: "approved",
    clientId: "cli",
    requestedScopes: [],
    intervalSec: 5,
    lastPollMs: 0,
    createdAt: now - 5000,
    expiresAt: now + 595_000,
    userCode: "AAAA-BBBB",
    userId: "alice",
    scopes: ["dovecote:notify"],
  });
  const first = await root.fetch(
    req({ grant_type: GRANT, device_code: "DCA2" }),
    env,
    execCtx(),
  );
  expect(first.status).toBe(201);
  const second = await root.fetch(
    req({ grant_type: GRANT, device_code: "DCA2" }),
    env,
    execCtx(),
  );
  expect(second.status).toBe(400);
  const body = (await second.json()) as any;
  expect(body.error).toBe("expired_token");
});

test("denied record → 400 access_denied", async () => {
  const env = buildEnv();
  const { root } = buildApp();
  const now = Date.now();
  await seed(env, "DCD", {
    status: "denied",
    clientId: "cli",
    requestedScopes: [],
    intervalSec: 5,
    lastPollMs: 0,
    createdAt: now - 1000,
    expiresAt: now + 599_000,
    userCode: "AAAA-BBBB",
  });
  const res = await root.fetch(
    req({ grant_type: GRANT, device_code: "DCD" }),
    env,
    execCtx(),
  );
  expect(res.status).toBe(400);
  expect(((await res.json()) as any).error).toBe("access_denied");
});

test("hard-expired record → 400 expired_token", async () => {
  const env = buildEnv();
  const { root } = buildApp();
  const now = Date.now();
  await seed(env, "DCX", {
    status: "pending",
    clientId: "cli",
    requestedScopes: [],
    intervalSec: 5,
    lastPollMs: 0,
    createdAt: now - 700_000,
    expiresAt: now - 1,
    userCode: "AAAA-BBBB",
  });
  const res = await root.fetch(
    req({ grant_type: GRANT, device_code: "DCX" }),
    env,
    execCtx(),
  );
  expect(res.status).toBe(400);
  expect(((await res.json()) as any).error).toBe("expired_token");
});

test("missing record → 400 expired_token", async () => {
  const env = buildEnv();
  const { root } = buildApp();
  const res = await root.fetch(
    req({ grant_type: GRANT, device_code: "DOES_NOT_EXIST" }),
    env,
    execCtx(),
  );
  expect(res.status).toBe(400);
  expect(((await res.json()) as any).error).toBe("expired_token");
});

test("wrong grant_type → 400 unsupported_grant_type", async () => {
  const env = buildEnv();
  const { root } = buildApp();
  const res = await root.fetch(
    req({ grant_type: "authorization_code", device_code: "DC1" }),
    env,
    execCtx(),
  );
  expect(res.status).toBe(400);
  expect(((await res.json()) as any).error).toBe("unsupported_grant_type");
});

test("HMAC_PEPPER empty → 503 misconfigured even with pending record", async () => {
  const env = buildEnv({ hmacPepper: "" });
  const { root } = buildApp();
  const res = await root.fetch(
    req({ grant_type: GRANT, device_code: "anything" }),
    env,
    execCtx(),
  );
  expect(res.status).toBe(503);
  expect(((await res.json()) as any).error).toBe("misconfigured");
});

test("approval branch: issueToken throws MissingPepper → 503 misconfigured", async () => {
  const env = buildEnv();
  const services = makeServices({
    issueToken: mock(async () => {
      throw new MissingPepperError();
    }),
  });
  const { root } = buildApp(services);
  const now = Date.now();
  await seed(env, "DCM", {
    status: "approved",
    clientId: "cli",
    requestedScopes: [],
    intervalSec: 5,
    lastPollMs: 0,
    createdAt: now - 1000,
    expiresAt: now + 599_000,
    userCode: "AAAA-BBBB",
    userId: "alice",
    scopes: ["dovecote:notify"],
  });
  const res = await root.fetch(
    req({ grant_type: GRANT, device_code: "DCM" }),
    env,
    execCtx(),
  );
  expect(res.status).toBe(503);
  expect(((await res.json()) as any).error).toBe("misconfigured");
});

test("approval branch: InvalidScopeError → 400 invalid_request", async () => {
  const env = buildEnv();
  const services = makeServices({
    issueToken: mock(async () => {
      throw new InvalidScopeError("foo:bar");
    }),
  });
  const { root } = buildApp(services);
  const now = Date.now();
  await seed(env, "DCS", {
    status: "approved",
    clientId: "cli",
    requestedScopes: [],
    intervalSec: 5,
    lastPollMs: 0,
    createdAt: now - 1000,
    expiresAt: now + 599_000,
    userCode: "AAAA-BBBB",
    userId: "alice",
    scopes: ["foo:bar"],
  });
  const res = await root.fetch(
    req({ grant_type: GRANT, device_code: "DCS" }),
    env,
    execCtx(),
  );
  expect(res.status).toBe(400);
  expect(((await res.json()) as any).error).toBe("invalid_request");
});

test("rate-limit overflow → 429 with Retry-After:60 (distinct from slow_down)", async () => {
  const env = buildEnv();
  const services = makeServices({
    checkRateLimit: mock(async () => ({ allowed: false, current: 6 })),
  });
  const { root } = buildApp(services);
  const res = await root.fetch(
    req({ grant_type: GRANT, device_code: "DC1" }),
    env,
    execCtx(),
  );
  expect(res.status).toBe(429);
  expect(res.headers.get("Retry-After")).toBe("60");
});

test("TTL no-reset: pending-poll write never extends original 600s TTL", async () => {
  const env = buildEnv();
  const { root } = buildApp();
  const now = Date.now();
  // Original TTL was 600s; seed with expiresAt 100s in the future, so any
  // rewrite must clamp to ~100s, NOT reset to 600.
  await seed(env, "DCT", {
    status: "pending",
    clientId: "cli",
    requestedScopes: [],
    intervalSec: 5,
    lastPollMs: now - 100, // → slow_down branch
    createdAt: now - 500_000,
    expiresAt: now + 100_000,
    userCode: "AAAA-BBBB",
  });
  const kv = env.OAUTH_KV as any as MockKV;
  const putSpy = spyOn(kv, "put");
  try {
    await root.fetch(req({ grant_type: GRANT, device_code: "DCT" }), env, execCtx());
    // At least one put for the device record
    const deviceWrites = putSpy.mock.calls.filter(
      (c) => (c[0] as string) === "device:DCT",
    );
    expect(deviceWrites.length).toBeGreaterThan(0);
    for (const call of deviceWrites) {
      const opts = call[2] as { expirationTtl?: number } | undefined;
      expect(typeof opts?.expirationTtl).toBe("number");
      // Never exceeds the original 600 — and never resets above what remains.
      expect(opts!.expirationTtl!).toBeLessThanOrEqual(600);
      expect(opts!.expirationTtl!).toBeLessThanOrEqual(101); // remaining ~100
      expect(opts!.expirationTtl!).toBeGreaterThan(0);
    }
  } finally {
    putSpy.mockRestore();
  }
});
