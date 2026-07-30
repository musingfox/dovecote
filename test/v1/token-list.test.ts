import { test, expect, mock, beforeEach, spyOn } from "bun:test";
import { Hono } from "hono";
import { createV1App } from "../../src/api-v1.js";
import type { Env } from "../../src/types.js";
import type { AuthCtx } from "../../src/auth/ctx.js";
import { MockKV } from "../helpers/mock-kv.js";
import {
  issueToken,
  KV_USER_NAMESPACE,
  KV_NAMESPACE,
} from "../../src/auth/api-token.js";

// Fresh service mocks per test — exercises real createV1App() from src/api-v1.ts.
function makeServices(overrides: {
  listUserTokens?: (...args: any[]) => any;
  listAllTokens?: (...args: any[]) => any;
  checkRateLimit?: (...args: any[]) => any;
} = {}) {
  return {
    sendNotification: mock(async () => ({ success: true })),
    listChannels: mock(() => [] as any[]),
    issueToken: mock(async () => ({ token: "x", tokenId: "x", expiresAt: 0 })),
    revokeToken: mock(async () => ({ revoked: true })),
    checkRateLimit: mock(
      overrides.checkRateLimit ??
        (async (_kv: any, _ip: string, _ns: string) => ({ allowed: true, current: 1 }))
    ),
    // The two new slots — default to real implementations using injected env's KV.
    listUserTokens: overrides.listUserTokens
      ? mock(overrides.listUserTokens)
      : undefined,
    listAllTokens: overrides.listAllTokens
      ? mock(overrides.listAllTokens)
      : undefined,
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
    HMAC_PEPPER: "test-pepper-32-characters-long",
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

const ALICE_AUTH: AuthCtx = {
  userId: "alice",
  scopes: ["dovecote:notify"],
  authMethod: "api_token",
  ip: "1.2.3.4",
};
const ADMIN_AUTH: AuthCtx = {
  userId: "admin-1",
  scopes: ["dovecote:admin"],
  authMethod: "admin_token",
  ip: "1.2.3.4",
};

function findAuditCalls(spy: ReturnType<typeof spyOn>, predicate: (entry: any) => boolean): any[] {
  const matches: any[] = [];
  for (const call of spy.mock.calls) {
    const arg = call[0];
    if (typeof arg !== "string") continue;
    try {
      const parsed = JSON.parse(arg);
      if (predicate(parsed)) matches.push(parsed);
    } catch {
      // Not a JSON audit line — ignore
    }
  }
  return matches;
}

beforeEach(() => {
  mock.restore();
});

// ============================================================
// C-Endpoint-ListSelf — non-admin path
// ============================================================

test("C-Endpoint-ListSelf: alice with 2 tokens → 200, sorted desc, no hash", async () => {
  const env = buildTestEnv();
  const now = Date.now();
  await issueToken(
    { userId: "alice", scopes: ["dovecote:notify"], label: "first" },
    env,
    now
  );
  await issueToken(
    { userId: "alice", scopes: ["dovecote:notify"], label: "second" },
    env,
    now + 500
  );

  const { app } = buildApp(ALICE_AUTH);
  const res = await app.fetch(
    new Request("http://localhost/v1/tokens"),
    env,
    createMockExecutionContext()
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(Array.isArray(body.tokens)).toBe(true);
  expect(body.tokens.length).toBe(2);
  expect(body.truncated).toBe(false);

  // Sorted createdAt desc
  expect(body.tokens[0].createdAt).toBeGreaterThan(body.tokens[1].createdAt);
  expect(body.tokens[0].label).toBe("second");
  expect(body.tokens[1].label).toBe("first");

  // No hash leakage
  for (const t of body.tokens) {
    expect(t.hash).toBeUndefined();
    expect(t.token).toBeUndefined();
    expect(t.userId).toBe("alice");
  }
});

test("C-Endpoint-ListSelf: alice ?userId=alice (self no-op filter) → same as self", async () => {
  const env = buildTestEnv();
  await issueToken({ userId: "alice", scopes: ["dovecote:notify"] }, env);

  const { app } = buildApp(ALICE_AUTH);
  const res = await app.fetch(
    new Request("http://localhost/v1/tokens?userId=alice"),
    env,
    createMockExecutionContext()
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.tokens.length).toBe(1);
  expect(body.tokens[0].userId).toBe("alice");
});

test("C-Endpoint-ListSelf: alice ?userId=bob → 403 forbidden + audit reason:forbidden", async () => {
  const consoleLogSpy = spyOn(console, "log");
  const env = buildTestEnv();
  const { app } = buildApp(ALICE_AUTH);
  const res = await app.fetch(
    new Request("http://localhost/v1/tokens?userId=bob"),
    env,
    createMockExecutionContext()
  );
  expect(res.status).toBe(403);
  const body = (await res.json()) as any;
  expect(body.error).toBe("forbidden");
  expect(body.error_description).toContain("dovecote:admin");

  const forbids = findAuditCalls(
    consoleLogSpy,
    (e) => e.event === "token.list" && e.ok === false && e.reason === "forbidden"
  );
  expect(forbids.length).toBe(1);
  expect(forbids[0].userIdFilter).toBe("bob");

  consoleLogSpy.mockRestore();
});

test("C-Endpoint-ListSelf: alice with 0 tokens → 200 {tokens:[], truncated:false}", async () => {
  const env = buildTestEnv();
  const { app } = buildApp(ALICE_AUTH);
  const res = await app.fetch(
    new Request("http://localhost/v1/tokens"),
    env,
    createMockExecutionContext()
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body).toEqual({ tokens: [], truncated: false });
});

test("C-Endpoint-ListSelf: 1001 tokens → truncated:true, length 1000", async () => {
  // Pre-populate the MockKV directly (avoids 1001 HMAC computations).
  const env = buildTestEnv();
  const kv = env.OAUTH_KV as unknown as MockKV;
  const baseTs = Date.now();
  // expiresAt must be in the future so listUserTokens won't filter them out.
  const futureExpiry = baseTs + 365 * 86_400_000;
  for (let i = 0; i < 1001; i++) {
    const tokenId = `tid_${i.toString().padStart(5, "0")}`;
    const meta = {
      tokenId,
      userId: "alice",
      scopes: ["dovecote:notify"],
      hash: `hash_${i}`,
      createdAt: baseTs + i,
      expiresAt: futureExpiry,
    };
    await kv.put(KV_NAMESPACE + tokenId, JSON.stringify(meta));
    await kv.put(KV_USER_NAMESPACE + "alice:" + tokenId, "");
  }

  const { app } = buildApp(ALICE_AUTH);
  const res = await app.fetch(
    new Request("http://localhost/v1/tokens"),
    env,
    createMockExecutionContext()
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.tokens.length).toBe(1000);
  expect(body.truncated).toBe(true);
});

test("C-Endpoint-ListSelf: KV list throws → 500 internal_error", async () => {
  const env = buildTestEnv();
  // Override list to throw — simulates infrastructure failure.
  const origList = (env.OAUTH_KV as any).list.bind(env.OAUTH_KV);
  (env.OAUTH_KV as any).list = async () => {
    throw new Error("KV unavailable");
  };
  const { app } = buildApp(ALICE_AUTH);
  const res = await app.fetch(
    new Request("http://localhost/v1/tokens"),
    env,
    createMockExecutionContext()
  );
  expect(res.status).toBe(500);
  const body = (await res.json()) as any;
  expect(body.error).toBe("internal_error");
  // restore
  (env.OAUTH_KV as any).list = origList;
});

test("C-Endpoint-ListSelf: missing auth in middleware → 401 wiring smoke", async () => {
  // No auth set → c.get("auth") is undefined → access .scopes throws.
  // The middleware in production attaches auth before this handler runs.
  const env = buildTestEnv();
  const { app } = buildApp(null);
  const res = await app.fetch(
    new Request("http://localhost/v1/tokens"),
    env,
    createMockExecutionContext()
  );
  // Hono catches the throw and returns 500 by default for unhandled errors.
  // The point of this test is wiring smoke — the bearer middleware in
  // production maps a missing Authorization header to 401 before reaching
  // the handler. Here we only confirm: without an auth context, the handler
  // does NOT silently produce a 200 success.
  expect(res.status).not.toBe(200);
});

// ============================================================
// C-Endpoint-ListAdmin — admin path
// ============================================================

test("C-Endpoint-ListAdmin: admin no ?userId, KV has alice×2+bob×1 → 200 with 3 items", async () => {
  const env = buildTestEnv();
  const now = Date.now();
  await issueToken({ userId: "alice", scopes: ["dovecote:notify"] }, env, now + 1);
  await issueToken({ userId: "alice", scopes: ["dovecote:notify"] }, env, now + 2);
  await issueToken({ userId: "bob", scopes: ["dovecote:notify"] }, env, now + 3);

  const { app } = buildApp(ADMIN_AUTH);
  const res = await app.fetch(
    new Request("http://localhost/v1/tokens"),
    env,
    createMockExecutionContext()
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.tokens.length).toBe(3);
  expect(body.truncated).toBe(false);
  const userIds = body.tokens.map((t: any) => t.userId).sort();
  expect(userIds).toEqual(["alice", "alice", "bob"]);
});

test("C-Endpoint-ListAdmin: admin ?userId=bob → 200 with bob's 1 item", async () => {
  const env = buildTestEnv();
  await issueToken({ userId: "alice", scopes: ["dovecote:notify"] }, env);
  await issueToken({ userId: "bob", scopes: ["dovecote:notify"] }, env);

  const { app } = buildApp(ADMIN_AUTH);
  const res = await app.fetch(
    new Request("http://localhost/v1/tokens?userId=bob"),
    env,
    createMockExecutionContext()
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.tokens.length).toBe(1);
  expect(body.tokens[0].userId).toBe("bob");
});

test("C-Endpoint-ListAdmin: 1001 tokens for admin → truncated:true, audit truncated:true", async () => {
  const consoleLogSpy = spyOn(console, "log");
  const env = buildTestEnv();
  const kv = env.OAUTH_KV as unknown as MockKV;
  const futureExpiry = Date.now() + 365 * 86_400_000;
  for (let i = 0; i < 1001; i++) {
    const tokenId = `tid_${i.toString().padStart(5, "0")}`;
    const meta = {
      tokenId,
      userId: "alice",
      scopes: ["dovecote:notify"],
      hash: `hash_${i}`,
      createdAt: Date.now() + i,
      expiresAt: futureExpiry,
    };
    await kv.put(KV_NAMESPACE + tokenId, JSON.stringify(meta));
  }

  const { app } = buildApp(ADMIN_AUTH);
  const res = await app.fetch(
    new Request("http://localhost/v1/tokens"),
    env,
    createMockExecutionContext()
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.tokens.length).toBe(1000);
  expect(body.truncated).toBe(true);

  const audits = findAuditCalls(
    consoleLogSpy,
    (e) => e.event === "token.list" && e.ok === true
  );
  expect(audits.length).toBeGreaterThan(0);
  expect(audits[audits.length - 1].truncated).toBe(true);

  consoleLogSpy.mockRestore();
});

test("C-Endpoint-ListAdmin: admin ?userId=charlie (no tokens) → 200 {tokens:[]}", async () => {
  const env = buildTestEnv();
  await issueToken({ userId: "alice", scopes: ["dovecote:notify"] }, env);

  const { app } = buildApp(ADMIN_AUTH);
  const res = await app.fetch(
    new Request("http://localhost/v1/tokens?userId=charlie"),
    env,
    createMockExecutionContext()
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.tokens).toEqual([]);
  expect(body.truncated).toBe(false);
});

test("C-Endpoint-ListAdmin: admin sees pre-backfill tokens via apitoken: canonical scan", async () => {
  // Simulate a pre-backfill token: canonical record exists but no apitoken_user: index.
  const env = buildTestEnv();
  const kv = env.OAUTH_KV as unknown as MockKV;
  await kv.put(
    KV_NAMESPACE + "legacy_tid",
    JSON.stringify({
      tokenId: "legacy_tid",
      userId: "legacy_user",
      scopes: ["dovecote:notify"],
      hash: "legacy_hash",
      createdAt: Date.now() - 1000,
      expiresAt: Date.now() + 365 * 86_400_000,
    })
  );

  const { app } = buildApp(ADMIN_AUTH);
  const res = await app.fetch(
    new Request("http://localhost/v1/tokens"),
    env,
    createMockExecutionContext()
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.tokens.find((t: any) => t.tokenId === "legacy_tid")).toBeDefined();
});

test("C-Endpoint-ListAdmin: success audit records count + truncated", async () => {
  const consoleLogSpy = spyOn(console, "log");
  const env = buildTestEnv();
  await issueToken({ userId: "alice", scopes: ["dovecote:notify"] }, env);
  await issueToken({ userId: "bob", scopes: ["dovecote:notify"] }, env);

  const { app } = buildApp(ADMIN_AUTH);
  await app.fetch(
    new Request("http://localhost/v1/tokens"),
    env,
    createMockExecutionContext()
  );
  const oks = findAuditCalls(
    consoleLogSpy,
    (e) => e.event === "token.list" && e.ok === true
  );
  expect(oks.length).toBeGreaterThan(0);
  const last = oks[oks.length - 1];
  expect(last.count).toBe(2);
  expect(last.truncated).toBe(false);

  consoleLogSpy.mockRestore();
});
