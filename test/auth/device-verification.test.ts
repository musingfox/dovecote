import { test, expect, mock, beforeEach } from "bun:test";
import { Hono } from "hono";
import { createDeviceVerificationApp } from "../../src/device-verification.js";
import type { Env } from "../../src/types.js";
import { MockKV } from "../helpers/mock-kv.js";
import { generateCSRF } from "../../src/auth/csrf.js";
import type { DeviceRecord } from "../../src/contracts/devices.js";

function buildEnv(): Env {
  return {
    OAUTH_KV: new MockKV() as any,
    OAUTH_PASSWORD: "test",
    COOKIE_ENCRYPTION_KEY: "x".repeat(32),
    HMAC_PEPPER: "pepper",
  };
}

function execCtx() {
  return {
    waitUntil: (_p: Promise<any>) => {},
    passThroughOnException: () => {},
  } as any;
}

function buildApp(resolveUserId?: any) {
  const root = new Hono<{ Bindings: Env }>();
  root.route("/", createDeviceVerificationApp(
    resolveUserId ? { resolveUserId } : {},
  ));
  return root;
}

async function postForm(opts: {
  csrf?: string;
  cookie?: string;
  fields: Record<string, string>;
}): Promise<Request> {
  const fd = new URLSearchParams();
  if (opts.csrf !== undefined) fd.set("csrf_token", opts.csrf);
  for (const [k, v] of Object.entries(opts.fields)) {
    fd.set(k, v);
  }
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (opts.cookie) headers["Cookie"] = opts.cookie;
  return new Request("http://localhost/device", {
    method: "POST",
    headers,
    body: fd.toString(),
  });
}

async function getValidCsrfPair(env: Env) {
  const { token, cookie } = await generateCSRF({
    secretKey: env.COOKIE_ENCRYPTION_KEY,
  });
  // Cookie header doesn't include the attribute clauses
  const cookieHeader = cookie.split(";")[0]!;
  return { token, cookieHeader };
}

async function seedPending(env: Env, deviceCode: string, normalized: string) {
  const now = Date.now();
  const record: DeviceRecord = {
    status: "pending",
    clientId: "cli",
    requestedScopes: [],
    intervalSec: 5,
    lastPollMs: 0,
    createdAt: now,
    expiresAt: now + 600_000,
    userCode: `${normalized.slice(0, 4)}-${normalized.slice(4)}`,
  };
  await (env.OAUTH_KV as any).put(`device:${deviceCode}`, JSON.stringify(record), {
    expirationTtl: 600,
  });
  await (env.OAUTH_KV as any).put(`device_user:${normalized}`, deviceCode, {
    expirationTtl: 600,
  });
  return record;
}

beforeEach(() => {
  mock.restore();
});

// --- GET /device ---------------------------------------------------------

test("GET /device renders form with CSRF + security headers", async () => {
  const env = buildEnv();
  const root = buildApp();
  const res = await root.fetch(
    new Request("http://localhost/device"),
    env,
    execCtx(),
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  expect(res.headers.get("Set-Cookie")).toContain("HttpOnly");
  expect(res.headers.get("Set-Cookie")).toContain("Secure");
  const html = await res.text();
  expect(html).toContain('name="csrf_token"');
  expect(html).toContain('name="user_code"');
  expect(html).toContain('name="username"');
  expect(html).toContain('name="password"');
});

test("GET /device?user_code=BCDF-GHJK pre-fills the input", async () => {
  const env = buildEnv();
  const root = buildApp();
  const res = await root.fetch(
    new Request("http://localhost/device?user_code=BCDF-GHJK"),
    env,
    execCtx(),
  );
  const html = await res.text();
  expect(html).toContain('value="BCDF-GHJK"');
});

// --- POST /device --------------------------------------------------------

test("POST /device missing csrf_token (cookie present) → 400; record untouched", async () => {
  const env = buildEnv();
  const root = buildApp();
  const seeded = await seedPending(env, "DCV1", "BCDFGHJK");
  const { cookieHeader } = await getValidCsrfPair(env);
  const r = await postForm({
    cookie: cookieHeader, // cookie set but no csrf_token field
    fields: {
      user_code: "BCDF-GHJK",
      username: "alice",
      password: "pw",
      action: "approve",
    },
  });
  const res = await root.fetch(r, env, execCtx());
  expect(res.status).toBe(400);
  const stored = await (env.OAUTH_KV as any).get("device:DCV1", "json");
  expect(stored.status).toBe(seeded.status); // still pending
});

test("POST /device wrong cookie/token pair → 400; record untouched", async () => {
  const env = buildEnv();
  const root = buildApp();
  await seedPending(env, "DCV2", "BCDFGHJK");
  // Cookie from a DIFFERENT pair than the token field
  const a = await getValidCsrfPair(env);
  const b = await getValidCsrfPair(env);
  const r = await postForm({
    csrf: a.token,
    cookie: b.cookieHeader,
    fields: {
      user_code: "BCDF-GHJK",
      username: "alice",
      password: "pw",
      action: "approve",
    },
  });
  const res = await root.fetch(r, env, execCtx());
  expect(res.status).toBe(400);
  const stored = await (env.OAUTH_KV as any).get("device:DCV2", "json");
  expect(stored.status).toBe("pending");
});

test("POST /device unknown user_code → 400 with inline 'not recognized'", async () => {
  const env = buildEnv();
  const root = buildApp(mock(async () => ({ userId: "alice", scopes: ["dovecote:notify"] })));
  const { token, cookieHeader } = await getValidCsrfPair(env);
  const r = await postForm({
    csrf: token,
    cookie: cookieHeader,
    fields: {
      user_code: "ZZZZ-ZZZZ",
      username: "alice",
      password: "pw",
      action: "approve",
    },
  });
  const res = await root.fetch(r, env, execCtx());
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("not recognized");
});

test("POST /device valid csrf+user_code, bad creds → 403; record untouched", async () => {
  const env = buildEnv();
  const root = buildApp(mock(async () => null));
  await seedPending(env, "DCV3", "BCDFGHJK");
  const { token, cookieHeader } = await getValidCsrfPair(env);
  const r = await postForm({
    csrf: token,
    cookie: cookieHeader,
    fields: {
      user_code: "BCDF-GHJK",
      username: "alice",
      password: "wrong",
      action: "approve",
    },
  });
  const res = await root.fetch(r, env, execCtx());
  expect(res.status).toBe(403);
  const stored = await (env.OAUTH_KV as any).get("device:DCV3", "json");
  expect(stored.status).toBe("pending");
});

test("POST /device approve valid → 200; record rewritten approved with preserved TTL", async () => {
  const env = buildEnv();
  const root = buildApp(
    mock(async () => ({ userId: "alice", scopes: ["dovecote:notify"] })),
  );
  await seedPending(env, "DCV4", "BCDFGHJK");
  const { token, cookieHeader } = await getValidCsrfPair(env);
  const r = await postForm({
    csrf: token,
    cookie: cookieHeader,
    fields: {
      user_code: "BCDF-GHJK",
      username: "alice",
      password: "pw",
      action: "approve",
    },
  });
  const res = await root.fetch(r, env, execCtx());
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("approved");
  const kv = env.OAUTH_KV as any as MockKV;
  const stored = await kv.get("device:DCV4", "json");
  expect(stored.status).toBe("approved");
  expect(stored.userId).toBe("alice");
  expect(stored.scopes).toEqual(["dovecote:notify"]);
  // TTL preserved — never reset above original 600.
  const ttl = kv.getStore().get("device:DCV4")!.expirationTtl;
  expect(ttl).toBeLessThanOrEqual(600);
  expect(ttl).toBeGreaterThan(0);
});

test("POST /device deny → 200; record marked denied", async () => {
  const env = buildEnv();
  const root = buildApp(
    mock(async () => ({ userId: "alice", scopes: ["dovecote:notify"] })),
  );
  await seedPending(env, "DCV5", "BCDFGHJK");
  const { token, cookieHeader } = await getValidCsrfPair(env);
  const r = await postForm({
    csrf: token,
    cookie: cookieHeader,
    fields: {
      user_code: "BCDF-GHJK",
      username: "alice",
      password: "pw",
      action: "deny",
    },
  });
  const res = await root.fetch(r, env, execCtx());
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("denied");
  const stored = await (env.OAUTH_KV as any).get("device:DCV5", "json");
  expect(stored.status).toBe("denied");
});

test("POST /device approve filters requestedScopes ∩ user.scopes", async () => {
  const env = buildEnv();
  const root = buildApp(
    mock(async () => ({ userId: "alice", scopes: ["dovecote:notify"] })),
  );
  const now = Date.now();
  const record: DeviceRecord = {
    status: "pending",
    clientId: "cli",
    // Requested both, but user only has notify
    requestedScopes: ["dovecote:notify", "dovecote:admin"],
    intervalSec: 5,
    lastPollMs: 0,
    createdAt: now,
    expiresAt: now + 600_000,
    userCode: "BCDF-GHJK",
  };
  await (env.OAUTH_KV as any).put("device:DCV6", JSON.stringify(record), {
    expirationTtl: 600,
  });
  await (env.OAUTH_KV as any).put("device_user:BCDFGHJK", "DCV6", {
    expirationTtl: 600,
  });

  const { token, cookieHeader } = await getValidCsrfPair(env);
  const r = await postForm({
    csrf: token,
    cookie: cookieHeader,
    fields: {
      user_code: "BCDF-GHJK",
      username: "alice",
      password: "pw",
      action: "approve",
    },
  });
  const res = await root.fetch(r, env, execCtx());
  expect(res.status).toBe(200);
  const stored = await (env.OAUTH_KV as any).get("device:DCV6", "json");
  expect(stored.scopes).toEqual(["dovecote:notify"]);
});
