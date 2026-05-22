import { test, expect } from "bun:test";
import authorizeApp from "../../src/auth/authorize.js";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../../src/types.js";
import { MockKV } from "../helpers/mock-kv.js";

interface AuthEnv extends Env {
  OAUTH_PROVIDER: OAuthHelpers;
}

function makeProviderRecorder(): {
  provider: OAuthHelpers;
  calls: Array<{ grantId: string; userId: string }>;
} {
  const calls: Array<{ grantId: string; userId: string }> = [];
  const provider: OAuthHelpers = {
    revokeGrant: async (grantId: string, userId: string) => {
      calls.push({ grantId, userId });
    },
    parseAuthRequest: async () => ({} as any),
    completeAuthorization: async () => ({} as any),
    lookupClient: async () => null,
    createClient: async () => ({} as any),
    listClients: async () => ({ items: [] }),
    updateClient: async () => null,
    deleteClient: async () => {},
    listUserGrants: async () => ({ items: [] }),
    unwrapToken: async () => null,
    exchangeToken: async () => ({} as any),
  };
  return { provider, calls };
}

function makeEnv(overrides: Partial<AuthEnv> = {}, provider?: OAuthHelpers): AuthEnv {
  return {
    OAUTH_KV: new MockKV() as any,
    OAUTH_PASSWORD: "test-pass",
    COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length",
    HMAC_PEPPER: "test-pepper",
    ADMIN_REVOKE_TOKEN: "tok",
    OAUTH_PROVIDER: provider ?? ({} as any),
    ...overrides,
  };
}

test("admin revoke: success with valid token, grantId, userId=alice", async () => {
  const kv = new MockKV();
  const { provider, calls } = makeProviderRecorder();
  const env = makeEnv({ OAUTH_KV: kv as any }, provider);

  const req = new Request("https://example.com/admin/revoke", {
    method: "POST",
    headers: {
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
      "CF-Connecting-IP": "1.2.3.4",
    },
    body: JSON.stringify({ grantId: "abcdefghijklmnopqrst", userId: "alice" }),
  });

  const res = await authorizeApp.fetch(req, env);

  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data).toEqual({ ok: true, grantId: "abcdefghijklmnopqrst" });

  // Verify revokeGrant was called with correct userId
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual({ grantId: "abcdefghijklmnopqrst", userId: "alice" });

  // Verify audit was written
  const auditKeys = Array.from(kv.getStore().keys()).filter((k) => k.startsWith("audit:"));
  expect(auditKeys.length).toBe(1);
  const auditEntry = JSON.parse(kv.getStore().get(auditKeys[0]!)!.value);
  expect(auditEntry.event).toBe("admin.revoke");
  expect(auditEntry.ok).toBe(true);
  expect(auditEntry.grantId).toBe("abcdefghijklmnopqrst");
});

test("admin revoke: userId=operator (back-compat) → 200, provider called with operator", async () => {
  const kv = new MockKV();
  const { provider, calls } = makeProviderRecorder();
  const env = makeEnv({ OAUTH_KV: kv as any }, provider);

  const req = new Request("https://example.com/admin/revoke", {
    method: "POST",
    headers: {
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ grantId: "abcdefghijklmnopqrst", userId: "operator" }),
  });

  const res = await authorizeApp.fetch(req, env);
  expect(res.status).toBe(200);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual({ grantId: "abcdefghijklmnopqrst", userId: "operator" });
});

test("admin revoke: missing userId returns 400", async () => {
  const { provider, calls } = makeProviderRecorder();
  const env = makeEnv({}, provider);

  const req = new Request("https://example.com/admin/revoke", {
    method: "POST",
    headers: {
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ grantId: "abcdefghijklmnopqrst" }),
  });

  const res = await authorizeApp.fetch(req, env);
  expect(res.status).toBe(400);
  expect(calls).toHaveLength(0);
});

test("admin revoke: invalid charset userId AL:ICE returns 400", async () => {
  const { provider, calls } = makeProviderRecorder();
  const env = makeEnv({}, provider);

  const req = new Request("https://example.com/admin/revoke", {
    method: "POST",
    headers: {
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ grantId: "abcdefghijklmnopqrst", userId: "AL:ICE" }),
  });

  const res = await authorizeApp.fetch(req, env);
  expect(res.status).toBe(400);
  expect(calls).toHaveLength(0);
});

test("admin revoke: wrong token returns 401", async () => {
  const kv = new MockKV();
  const { provider } = makeProviderRecorder();
  const env = makeEnv({ OAUTH_KV: kv as any }, provider);

  const req = new Request("https://example.com/admin/revoke", {
    method: "POST",
    headers: {
      Authorization: "Bearer wrong",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ grantId: "abcdefghijklmnopqrst", userId: "alice" }),
  });

  const res = await authorizeApp.fetch(req, env);

  expect(res.status).toBe(401);
  const data = await res.json();
  expect(data).toEqual({ error: "unauthorized" });

  const auditKeys = Array.from(kv.getStore().keys()).filter((k) => k.startsWith("audit:"));
  expect(auditKeys.length).toBe(1);
  const auditEntry = JSON.parse(kv.getStore().get(auditKeys[0]!)!.value);
  expect(auditEntry.event).toBe("admin.revoke");
  expect(auditEntry.ok).toBe(false);
  expect(auditEntry.reason).toBe("auth_failed");
});

test("admin revoke: missing Authorization header returns 401", async () => {
  const { provider } = makeProviderRecorder();
  const env = makeEnv({}, provider);

  const req = new Request("https://example.com/admin/revoke", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ grantId: "abcdefghijklmnopqrst", userId: "alice" }),
  });

  const res = await authorizeApp.fetch(req, env);
  expect(res.status).toBe(401);
});

test("admin revoke: malformed Authorization (Basic xxx) returns 401", async () => {
  const { provider } = makeProviderRecorder();
  const env = makeEnv({}, provider);

  const req = new Request("https://example.com/admin/revoke", {
    method: "POST",
    headers: {
      Authorization: "Basic xxx",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ grantId: "abcdefghijklmnopqrst", userId: "alice" }),
  });

  const res = await authorizeApp.fetch(req, env);
  expect(res.status).toBe(401);
});

test("admin revoke: token unset returns 503", async () => {
  const kv = new MockKV();
  const { provider } = makeProviderRecorder();
  const env: AuthEnv = {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "test-pass",
    COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length",
    HMAC_PEPPER: "test-pepper",
    // ADMIN_REVOKE_TOKEN not set
    OAUTH_PROVIDER: provider,
  };

  const req = new Request("https://example.com/admin/revoke", {
    method: "POST",
    headers: {
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ grantId: "abcdefghijklmnopqrst", userId: "alice" }),
  });

  const res = await authorizeApp.fetch(req, env);
  expect(res.status).toBe(503);
  const data = await res.json();
  expect(data).toEqual({ error: "revoke endpoint not configured" });

  const auditKeys = Array.from(kv.getStore().keys()).filter((k) => k.startsWith("audit:"));
  expect(auditKeys.length).toBe(0);
});

test("admin revoke: rate limited after 5 requests returns 429", async () => {
  const kv = new MockKV();
  const { provider } = makeProviderRecorder();
  const env = makeEnv({ OAUTH_KV: kv as any }, provider);

  for (let i = 0; i < 5; i++) {
    const req = new Request("https://example.com/admin/revoke", {
      method: "POST",
      headers: {
        Authorization: "Bearer tok",
        "Content-Type": "application/json",
        "CF-Connecting-IP": "1.2.3.4",
      },
      body: JSON.stringify({ grantId: `abcdefghijklmnopqrs${i}`, userId: "alice" }),
    });
    const res = await authorizeApp.fetch(req, env);
    expect(res.status).toBe(200);
  }

  const req6 = new Request("https://example.com/admin/revoke", {
    method: "POST",
    headers: {
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
      "CF-Connecting-IP": "1.2.3.4",
    },
    body: JSON.stringify({ grantId: "abcdefghijklmnopqrst", userId: "alice" }),
  });

  const res6 = await authorizeApp.fetch(req6, env);
  expect(res6.status).toBe(429);
  expect(res6.headers.get("Retry-After")).toBe("60");

  const auditKeys = Array.from(kv.getStore().keys()).filter((k) => k.startsWith("audit:"));
  const auditEntries = auditKeys.map((k) => JSON.parse(kv.getStore().get(k)!.value));
  const rateLimitedAudit = auditEntries.find((e) => e.reason === "rate_limited");
  expect(rateLimitedAudit).toBeTruthy();
});

test("admin revoke: invalid body (grantId regex) returns 400", async () => {
  const { provider } = makeProviderRecorder();
  const env = makeEnv({}, provider);

  const req = new Request("https://example.com/admin/revoke", {
    method: "POST",
    headers: {
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ grantId: "short", userId: "alice" }),
  });

  const res = await authorizeApp.fetch(req, env);
  expect(res.status).toBe(400);
});

test("admin revoke: invalid JSON returns 400", async () => {
  const { provider } = makeProviderRecorder();
  const env = makeEnv({}, provider);

  const req = new Request("https://example.com/admin/revoke", {
    method: "POST",
    headers: {
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
    },
    body: "not-json",
  });

  const res = await authorizeApp.fetch(req, env);
  expect(res.status).toBe(400);
  const data = await res.json();
  expect(data).toEqual({ error: "Invalid JSON" });
});

test("admin revoke: missing grantId field returns 400", async () => {
  const { provider } = makeProviderRecorder();
  const env = makeEnv({}, provider);

  const req = new Request("https://example.com/admin/revoke", {
    method: "POST",
    headers: {
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ userId: "alice" }),
  });

  const res = await authorizeApp.fetch(req, env);
  expect(res.status).toBe(400);
});

test("admin revoke: provider error returns 500", async () => {
  const kv = new MockKV();
  const failingProvider: OAuthHelpers = {
    revokeGrant: async () => {
      throw new Error("Provider error");
    },
    parseAuthRequest: async () => ({} as any),
    completeAuthorization: async () => ({} as any),
    lookupClient: async () => null,
    createClient: async () => ({} as any),
    listClients: async () => ({ items: [] }),
    updateClient: async () => null,
    deleteClient: async () => {},
    listUserGrants: async () => ({ items: [] }),
    unwrapToken: async () => null,
    exchangeToken: async () => ({} as any),
  };
  const env = makeEnv({ OAUTH_KV: kv as any }, failingProvider);

  const req = new Request("https://example.com/admin/revoke", {
    method: "POST",
    headers: {
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ grantId: "abcdefghijklmnopqrst", userId: "alice" }),
  });

  const res = await authorizeApp.fetch(req, env);
  expect(res.status).toBe(500);
  const data = await res.json();
  expect(data).toEqual({ error: "revoke failed" });

  const auditKeys = Array.from(kv.getStore().keys()).filter((k) => k.startsWith("audit:"));
  expect(auditKeys.length).toBe(1);
  const auditEntry = JSON.parse(kv.getStore().get(auditKeys[0]!)!.value);
  expect(auditEntry.reason).toBe("provider_error");
});

test("admin revoke: IP fallback to 'unknown' when CF-Connecting-IP missing", async () => {
  const kv = new MockKV();
  const { provider } = makeProviderRecorder();
  const env = makeEnv({ OAUTH_KV: kv as any }, provider);

  const req = new Request("https://example.com/admin/revoke", {
    method: "POST",
    headers: {
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ grantId: "abcdefghijklmnopqrst", userId: "alice" }),
  });

  const res = await authorizeApp.fetch(req, env);
  expect(res.status).toBe(200);

  const rateLimitKey = kv.getStore().get("rl:revoke:unknown");
  expect(rateLimitKey).toBeTruthy();
  expect(rateLimitKey?.value).toBe("1");
});

test("admin revoke: GET request returns 404", async () => {
  const { provider } = makeProviderRecorder();
  const env = makeEnv({}, provider);

  const req = new Request("https://example.com/admin/revoke", {
    method: "GET",
    headers: { Authorization: "Bearer tok" },
  });

  const res = await authorizeApp.fetch(req, env);
  expect(res.status).toBe(404);
});
