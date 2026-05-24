import { test, expect, mock, beforeEach, spyOn } from "bun:test";
import { Hono } from "hono";
import { createAuthExchangeDeviceApp } from "../../src/auth-exchange-device.js";
import type { Env } from "../../src/types.js";
import { MockKV } from "../helpers/mock-kv.js";
import { normalizeUserCode } from "../../src/auth/user-code.js";

function makeServices(overrides: { checkRateLimit?: any; issueToken?: any } = {}) {
  return {
    issueToken:
      overrides.issueToken ??
      mock(async () => ({
        token: "dvct_" + "a".repeat(32),
        tokenId: "tid_new",
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

function req(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/v1/auth/device-authorize", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  mock.restore();
});

test("happy path: returns device_code/user_code with TTL 600 and interval 5", async () => {
  const env = buildEnv();
  const { root } = buildApp();
  const res = await root.fetch(req({ client_id: "cli-x" }), env, execCtx());
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(typeof body.device_code).toBe("string");
  expect(body.device_code.length).toBeGreaterThanOrEqual(30);
  expect(body.user_code).toMatch(
    /^[BCDFGHJKLMNPQRSTVWXZ23456789]{4}-[BCDFGHJKLMNPQRSTVWXZ23456789]{4}$/,
  );
  expect(body.expires_in).toBe(600);
  expect(body.interval).toBe(5);
  expect(body.verification_uri).toBe("http://localhost/device");
  expect(body.verification_uri_complete).toContain("?user_code=");

  // KV side effects
  const kv = env.OAUTH_KV as any as MockKV;
  const stored = await kv.get(`device:${body.device_code}`, "json");
  expect(stored.status).toBe("pending");
  expect(stored.intervalSec).toBe(5);
  expect(stored.requestedScopes).toEqual([]);
  const ttl = kv.getStore().get(`device:${body.device_code}`)!.expirationTtl;
  expect(ttl).toBe(600);

  // device_user index points back at the device_code
  const normalized = normalizeUserCode(body.user_code);
  const lookup = await kv.get(`device_user:${normalized}`);
  expect(lookup).toBe(body.device_code);
});

test("scope: space-separated body becomes requestedScopes array", async () => {
  const env = buildEnv();
  const { root } = buildApp();
  const res = await root.fetch(
    req({ client_id: "cli-x", scope: "dovecote:notify foo:bar" }),
    env,
    execCtx(),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  const stored = await (env.OAUTH_KV as any).get(`device:${body.device_code}`, "json");
  expect(stored.requestedScopes).toEqual(["dovecote:notify", "foo:bar"]);
});

test("missing client_id → 400 with error_description mentioning client_id", async () => {
  const env = buildEnv();
  const { root } = buildApp();
  const res = await root.fetch(req({}), env, execCtx());
  expect(res.status).toBe(400);
  const body = (await res.json()) as any;
  expect(body.error).toBe("invalid_request");
  expect(String(body.error_description).toLowerCase()).toContain("client_id");
});

test("HMAC_PEPPER empty → 503 misconfigured", async () => {
  const env = buildEnv({ hmacPepper: "" });
  const { root } = buildApp();
  const res = await root.fetch(req({ client_id: "cli-x" }), env, execCtx());
  expect(res.status).toBe(503);
  const body = (await res.json()) as any;
  expect(body.error).toBe("misconfigured");
});

test("rate-limit overflow → 429 with Retry-After:60", async () => {
  const env = buildEnv();
  const services = makeServices({
    checkRateLimit: mock(async () => ({ allowed: false, current: 6 })),
  });
  const { root } = buildApp(services);
  const res = await root.fetch(req({ client_id: "cli-x" }), env, execCtx());
  expect(res.status).toBe(429);
  expect(res.headers.get("Retry-After")).toBe("60");
  const body = (await res.json()) as any;
  expect(body.error).toBe("rate_limited");
});

test("entropy: two consecutive calls produce distinct device_codes", async () => {
  const env = buildEnv();
  const { root } = buildApp();
  const r1 = await root.fetch(req({ client_id: "cli-x" }), env, execCtx());
  const r2 = await root.fetch(req({ client_id: "cli-x" }), env, execCtx());
  const b1 = (await r1.json()) as any;
  const b2 = (await r2.json()) as any;
  expect(b1.device_code).not.toBe(b2.device_code);
  expect(b1.user_code).not.toBe(b2.user_code);
});

test("audit: success emits auth.device.authorize ok:true with clientId/fingerprint", async () => {
  const env = buildEnv();
  const { root } = buildApp();
  const spy = spyOn(console, "log");
  try {
    const res = await root.fetch(req({ client_id: "cli-x" }), env, execCtx());
    expect(res.status).toBe(200);
    // Find the auth.device.authorize line — single audit line is logged.
    const logged = spy.mock.calls
      .map((c) => {
        try {
          return JSON.parse(c[0] as string);
        } catch {
          return null;
        }
      })
      .filter((x) => x && x.event === "auth.device.authorize");
    expect(logged.length).toBe(1);
    expect(logged[0].ok).toBe(true);
    expect(logged[0].authMethod).toBe("none");
    expect(logged[0].clientId).toBe("cli-x");
    expect(typeof logged[0].userCodeFingerprint).toBe("string");
    expect(logged[0].userCodeFingerprint.length).toBe(4);
  } finally {
    spy.mockRestore();
  }
});
