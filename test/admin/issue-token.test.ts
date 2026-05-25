import { test, expect } from "bun:test";
import { createAdminIssueTokenApp } from "../../src/admin-issue-token.js";
import { issueToken } from "../../src/auth/api-token.js";
import { checkRateLimit } from "../../src/auth/rate-limit.js";
import type { Env } from "../../src/types.js";
import { MockKV } from "../helpers/mock-kv.js";

function makeEnv(opts: { withPepper?: boolean } = {}): { env: Env; kv: MockKV } {
  const kv = new MockKV();
  const env: Env = {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "test-pass",
    COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length",
    ADMIN_REVOKE_TOKEN: "admin-tok",
    HMAC_PEPPER: opts.withPepper === false ? ("" as any) : "test-pepper",
  };
  return { env, kv };
}

async function seedUser(kv: MockKV, userId: string): Promise<void> {
  const record = {
    username: userId,
    algo: "pbkdf2-sha256",
    iterations: 100_000,
    salt: "AAAA",
    hash: "BBBB",
    scopes: ["dovecote:notify"],
  };
  await kv.put(`user:${userId}`, JSON.stringify(record));
}

function makeApp() {
  return createAdminIssueTokenApp({ issueToken, checkRateLimit });
}

function createExecCtx() {
  return {
    props: null,
    waitUntil: (_p: Promise<any>) => {},
    passThroughOnException: () => {},
  } as any;
}

function auditEntries(kv: MockKV): any[] {
  return Array.from(kv.getStore().keys())
    .filter((k) => k.startsWith("audit:"))
    .map((k) => JSON.parse(kv.getStore().get(k)!.value));
}

test("admin-issue-token: happy path mints dvct_* token and writes KV + audit", async () => {
  const { env, kv } = makeEnv();
  await seedUser(kv, "alice");
  const app = makeApp();

  const req = new Request("https://example.com/admin/issue-token", {
    method: "POST",
    headers: {
      Authorization: "Bearer admin-tok",
      "Content-Type": "application/json",
      "CF-Connecting-IP": "1.2.3.4",
    },
    body: JSON.stringify({
      userId: "alice",
      scopes: ["dovecote:notify", "dovecote:admin"],
      expiresInDays: 30,
      label: "laptop",
    }),
  });

  const res = await app.fetch(req, env, createExecCtx());
  expect(res.status).toBe(200);
  const data = (await res.json()) as any;

  expect(typeof data.token).toBe("string");
  expect(data.token.startsWith("dvct_")).toBe(true);
  expect(typeof data.tokenId).toBe("string");
  expect(data.tokenId.length).toBeGreaterThan(0);
  expect(data.userId).toBe("alice");
  expect(data.scopes).toEqual(["dovecote:notify", "dovecote:admin"]);
  expect(typeof data.expiresAt).toBe("number");
  expect(data.label).toBe("laptop");

  // KV: apitoken:<id> + apitoken_user:<userId>:<tokenId>
  const apitokenKey = `apitoken:${data.tokenId}`;
  expect(kv.getStore().get(apitokenKey)).toBeTruthy();
  const userIndexKey = `apitoken_user:alice:${data.tokenId}`;
  expect(kv.getStore().get(userIndexKey)).toBeTruthy();

  // Audit: token.issue ok=true reason=admin_issue
  const audits = auditEntries(kv);
  const ok = audits.find((e) => e.event === "token.issue" && e.ok === true);
  expect(ok).toBeTruthy();
  expect(ok.reason).toBe("admin_issue");
  expect(ok.userId).toBe("alice");
  expect(ok.tokenId).toBe(data.tokenId);
  expect(ok.scopes).toEqual(["dovecote:notify", "dovecote:admin"]);
  expect(ok.authMethod).toBe("admin_token");
});

test("admin-issue-token: missing Authorization header → 401 + audit auth_failed", async () => {
  const { env, kv } = makeEnv();
  await seedUser(kv, "alice");
  const app = makeApp();

  const req = new Request("https://example.com/admin/issue-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: "alice", scopes: ["dovecote:notify"] }),
  });

  const res = await app.fetch(req, env, createExecCtx());
  expect(res.status).toBe(401);
  const data = (await res.json()) as any;
  expect(data).toEqual({ error: "unauthorized" });

  const audits = auditEntries(kv);
  const failed = audits.find((e) => e.event === "token.issue" && e.ok === false);
  expect(failed).toBeTruthy();
  expect(failed.reason).toBe("auth_failed");
});

test("admin-issue-token: wrong admin token → 401 + audit auth_failed (timing-safe compare)", async () => {
  const { env, kv } = makeEnv();
  await seedUser(kv, "alice");
  const app = makeApp();

  const req = new Request("https://example.com/admin/issue-token", {
    method: "POST",
    headers: {
      Authorization: "Bearer not-the-admin-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ userId: "alice", scopes: ["dovecote:notify"] }),
  });

  const res = await app.fetch(req, env, createExecCtx());
  expect(res.status).toBe(401);
  const data = (await res.json()) as any;
  expect(data).toEqual({ error: "unauthorized" });

  const audits = auditEntries(kv);
  const failed = audits.find((e) => e.event === "token.issue" && e.ok === false);
  expect(failed).toBeTruthy();
  expect(failed.reason).toBe("auth_failed");

  // Length-differing strings also rejected (constant-time path).
  const req2 = new Request("https://example.com/admin/issue-token", {
    method: "POST",
    headers: {
      Authorization: "Bearer short",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ userId: "alice", scopes: ["dovecote:notify"] }),
  });
  const res2 = await app.fetch(req2, env, createExecCtx());
  expect(res2.status).toBe(401);
});

test("admin-issue-token: malformed body → 400 + audit invalid_body", async () => {
  const { env, kv } = makeEnv();
  await seedUser(kv, "alice");
  const app = makeApp();

  // Case A: empty userId
  const reqEmpty = new Request("https://example.com/admin/issue-token", {
    method: "POST",
    headers: {
      Authorization: "Bearer admin-tok",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ userId: "", scopes: ["dovecote:notify"] }),
  });
  const resEmpty = await app.fetch(reqEmpty, env, createExecCtx());
  expect(resEmpty.status).toBe(400);

  // Case B: non-array scopes
  const reqArr = new Request("https://example.com/admin/issue-token", {
    method: "POST",
    headers: {
      Authorization: "Bearer admin-tok",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ userId: "alice", scopes: "dovecote:notify" }),
  });
  const resArr = await app.fetch(reqArr, env, createExecCtx());
  expect(resArr.status).toBe(400);

  // Case C: expiresInDays = 0
  const reqZero = new Request("https://example.com/admin/issue-token", {
    method: "POST",
    headers: {
      Authorization: "Bearer admin-tok",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      userId: "alice",
      scopes: ["dovecote:notify"],
      expiresInDays: 0,
    }),
  });
  const resZero = await app.fetch(reqZero, env, createExecCtx());
  expect(resZero.status).toBe(400);

  // Case D: expiresInDays = 91 (over max)
  const reqOver = new Request("https://example.com/admin/issue-token", {
    method: "POST",
    headers: {
      Authorization: "Bearer admin-tok",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      userId: "alice",
      scopes: ["dovecote:notify"],
      expiresInDays: 91,
    }),
  });
  const resOver = await app.fetch(reqOver, env, createExecCtx());
  expect(resOver.status).toBe(400);

  const audits = auditEntries(kv);
  const invalidBody = audits.filter(
    (e) => e.event === "token.issue" && e.reason === "invalid_body",
  );
  expect(invalidBody.length).toBe(4);
});

test("admin-issue-token: user:<id> missing → 404 + audit user_not_found", async () => {
  const { env, kv } = makeEnv();
  // No seedUser
  const app = makeApp();

  const req = new Request("https://example.com/admin/issue-token", {
    method: "POST",
    headers: {
      Authorization: "Bearer admin-tok",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ userId: "ghost", scopes: ["dovecote:notify"] }),
  });

  const res = await app.fetch(req, env, createExecCtx());
  expect(res.status).toBe(404);
  const data = (await res.json()) as any;
  expect(data).toEqual({ error: "user_not_found" });

  const audits = auditEntries(kv);
  const failed = audits.find(
    (e) => e.event === "token.issue" && e.reason === "user_not_found",
  );
  expect(failed).toBeTruthy();
  expect(failed.userId).toBe("ghost");
});

test("admin-issue-token: HMAC_PEPPER unset → 503 misconfigured", async () => {
  const { env, kv } = makeEnv({ withPepper: false });
  await seedUser(kv, "alice");
  const app = makeApp();

  const req = new Request("https://example.com/admin/issue-token", {
    method: "POST",
    headers: {
      Authorization: "Bearer admin-tok",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ userId: "alice", scopes: ["dovecote:notify"] }),
  });

  const res = await app.fetch(req, env, createExecCtx());
  expect(res.status).toBe(503);
  const data = (await res.json()) as any;
  expect(data.error).toBe("misconfigured");
  expect(data.error_description).toBe("HMAC_PEPPER not configured");
});

test("admin-issue-token: invalid scope (dovecote:nonexistent) → 400 + audit invalid_body", async () => {
  const { env, kv } = makeEnv();
  await seedUser(kv, "alice");
  const app = makeApp();

  const req = new Request("https://example.com/admin/issue-token", {
    method: "POST",
    headers: {
      Authorization: "Bearer admin-tok",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      userId: "alice",
      scopes: ["dovecote:nonexistent"],
    }),
  });

  const res = await app.fetch(req, env, createExecCtx());
  expect(res.status).toBe(400);

  const audits = auditEntries(kv);
  const failed = audits.find(
    (e) => e.event === "token.issue" && e.reason === "invalid_body",
  );
  expect(failed).toBeTruthy();
});

test("admin-issue-token: 60 calls OK, 61st → 429 + Retry-After:60 + audit rate_limited", async () => {
  const { env, kv } = makeEnv();
  await seedUser(kv, "alice");
  const app = makeApp();

  for (let i = 0; i < 60; i++) {
    const req = new Request("https://example.com/admin/issue-token", {
      method: "POST",
      headers: {
        Authorization: "Bearer admin-tok",
        "Content-Type": "application/json",
        "CF-Connecting-IP": "9.9.9.9",
      },
      body: JSON.stringify({
        userId: "alice",
        scopes: ["dovecote:notify"],
        label: `lbl-${i}`,
      }),
    });
    const res = await app.fetch(req, env, createExecCtx());
    expect(res.status).toBe(200);
  }

  // 61st request should be rate-limited.
  const req61 = new Request("https://example.com/admin/issue-token", {
    method: "POST",
    headers: {
      Authorization: "Bearer admin-tok",
      "Content-Type": "application/json",
      "CF-Connecting-IP": "9.9.9.9",
    },
    body: JSON.stringify({
      userId: "alice",
      scopes: ["dovecote:notify"],
    }),
  });
  const res61 = await app.fetch(req61, env, createExecCtx());
  expect(res61.status).toBe(429);
  expect(res61.headers.get("Retry-After")).toBe("60");
  const data = (await res61.json()) as any;
  expect(data).toEqual({ error: "rate_limited" });

  const audits = auditEntries(kv);
  const rateLimited = audits.find(
    (e) => e.event === "token.issue" && e.reason === "rate_limited",
  );
  expect(rateLimited).toBeTruthy();
  expect(rateLimited.ok).toBe(false);
  expect(rateLimited.authMethod).toBe("admin_token");
});
