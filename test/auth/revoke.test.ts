import { test, expect } from "bun:test";
import authorizeApp from "../../src/auth/authorize.js";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../../src/types.js";
import { MockKV } from "../helpers/mock-kv.js";

/**
 * Create mock execution context for testing
 */
function createMockExecutionCtx() {
  const promises: Promise<any>[] = [];
  return {
    waitUntil: (p: Promise<any>) => {
      promises.push(p);
    },
    passThroughOnException: () => {},
    getPromises: () => promises,
  } as any;
}

interface AuthEnv extends Env {
  OAUTH_PROVIDER: OAuthHelpers;
}

test("admin revoke: success with valid token and grantId", async () => {
  const kv = new MockKV();
  const revokeGrantCalls: Array<{ grantId: string; userId: string }> = [];

  const mockProvider: OAuthHelpers = {
    revokeGrant: async (grantId: string, userId: string) => {
      revokeGrantCalls.push({ grantId, userId });
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

  const env: AuthEnv = {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "test-pass",
    COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length",
    ADMIN_REVOKE_TOKEN: "tok",
    OAUTH_PROVIDER: mockProvider,
  };

  const req = new Request("https://example.com/admin/revoke", {
    method: "POST",
    headers: {
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
      "CF-Connecting-IP": "1.2.3.4",
    },
    body: JSON.stringify({ grantId: "abcdefghijklmnopqrst" }),
  });

  const res = await authorizeApp.fetch(req, env);

  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data).toEqual({ ok: true, grantId: "abcdefghijklmnopqrst" });

  // Verify revokeGrant was called correctly
  expect(revokeGrantCalls).toHaveLength(1);
  expect(revokeGrantCalls[0]).toEqual({
    grantId: "abcdefghijklmnopqrst",
    userId: "operator",
  });

  // Verify audit was written
  const auditKeys = Array.from(kv.getStore().keys()).filter((k) => k.startsWith("audit:"));
  expect(auditKeys.length).toBe(1);
  const auditEntry = JSON.parse(kv.getStore().get(auditKeys[0]!)!.value);
  expect(auditEntry.event).toBe("admin.revoke");
  expect(auditEntry.ok).toBe(true);
  expect(auditEntry.grantId).toBe("abcdefghijklmnopqrst");
});

test("admin revoke: wrong token returns 401", async () => {
  const kv = new MockKV();

  const mockProvider: OAuthHelpers = {
    revokeGrant: async () => {},
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

  const env: AuthEnv = {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "test-pass",
    COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length",
    ADMIN_REVOKE_TOKEN: "tok",
    OAUTH_PROVIDER: mockProvider,
  };

  const req = new Request("https://example.com/admin/revoke", {
    method: "POST",
    headers: {
      Authorization: "Bearer wrong",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ grantId: "abcdefghijklmnopqrst" }),
  });

  const res = await authorizeApp.fetch(req, env);

  expect(res.status).toBe(401);
  const data = await res.json();
  expect(data).toEqual({ error: "unauthorized" });

  // Verify audit was written with auth_failed
  const auditKeys = Array.from(kv.getStore().keys()).filter((k) => k.startsWith("audit:"));
  expect(auditKeys.length).toBe(1);
  const auditEntry = JSON.parse(kv.getStore().get(auditKeys[0]!)!.value);
  expect(auditEntry.event).toBe("admin.revoke");
  expect(auditEntry.ok).toBe(false);
  expect(auditEntry.reason).toBe("auth_failed");
});

test("admin revoke: missing Authorization header returns 401", async () => {
  const kv = new MockKV();

  const mockProvider: OAuthHelpers = {
    revokeGrant: async () => {},
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

  const env: AuthEnv = {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "test-pass",
    COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length",
    ADMIN_REVOKE_TOKEN: "tok",
    OAUTH_PROVIDER: mockProvider,
  };

  const req = new Request("https://example.com/admin/revoke", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ grantId: "abcdefghijklmnopqrst" }),
  });

  const res = await authorizeApp.fetch(req, env);

  expect(res.status).toBe(401);
  const data = await res.json();
  expect(data).toEqual({ error: "unauthorized" });
});

test("admin revoke: malformed Authorization (Basic xxx) returns 401", async () => {
  const kv = new MockKV();

  const mockProvider: OAuthHelpers = {
    revokeGrant: async () => {},
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

  const env: AuthEnv = {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "test-pass",
    COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length",
    ADMIN_REVOKE_TOKEN: "tok",
    OAUTH_PROVIDER: mockProvider,
  };

  const req = new Request("https://example.com/admin/revoke", {
    method: "POST",
    headers: {
      Authorization: "Basic xxx",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ grantId: "abcdefghijklmnopqrst" }),
  });

  const res = await authorizeApp.fetch(req, env);

  expect(res.status).toBe(401);
  const data = await res.json();
  expect(data).toEqual({ error: "unauthorized" });
});

test("admin revoke: token unset returns 503", async () => {
  const kv = new MockKV();

  const mockProvider: OAuthHelpers = {
    revokeGrant: async () => {},
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

  const env: AuthEnv = {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "test-pass",
    COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length",
    // ADMIN_REVOKE_TOKEN not set
    OAUTH_PROVIDER: mockProvider,
  };

  const req = new Request("https://example.com/admin/revoke", {
    method: "POST",
    headers: {
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ grantId: "abcdefghijklmnopqrst" }),
  });

  const res = await authorizeApp.fetch(req, env);

  expect(res.status).toBe(503);
  const data = await res.json();
  expect(data).toEqual({ error: "revoke endpoint not configured" });

  // Verify no audit was written
  const auditKeys = Array.from(kv.getStore().keys()).filter((k) => k.startsWith("audit:"));
  expect(auditKeys.length).toBe(0);
});

test("admin revoke: rate limited after 5 requests returns 429", async () => {
  const kv = new MockKV();
  const revokeGrantCalls: Array<{ grantId: string; userId: string }> = [];

  const mockProvider: OAuthHelpers = {
    revokeGrant: async (grantId: string, userId: string) => {
      revokeGrantCalls.push({ grantId, userId });
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

  const env: AuthEnv = {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "test-pass",
    COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length",
    ADMIN_REVOKE_TOKEN: "tok",
    OAUTH_PROVIDER: mockProvider,
  };

  // Make 5 successful requests
  for (let i = 0; i < 5; i++) {
    const req = new Request("https://example.com/admin/revoke", {
      method: "POST",
      headers: {
        Authorization: "Bearer tok",
        "Content-Type": "application/json",
        "CF-Connecting-IP": "1.2.3.4",
      },
      body: JSON.stringify({ grantId: `abcdefghijklmnopqrs${i}` }),
    });

    const res = await authorizeApp.fetch(req, env);
    expect(res.status).toBe(200);
  }

  // 6th request should be rate limited
  const req6 = new Request("https://example.com/admin/revoke", {
    method: "POST",
    headers: {
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
      "CF-Connecting-IP": "1.2.3.4",
    },
    body: JSON.stringify({ grantId: "abcdefghijklmnopqrst" }),
  });

  const res6 = await authorizeApp.fetch(req6, env);
  expect(res6.status).toBe(429);
  expect(res6.headers.get("Retry-After")).toBe("60");
  const data = await res6.json();
  expect(data).toEqual({ error: "rate limited" });

  // Verify rate_limited audit was written
  const auditKeys = Array.from(kv.getStore().keys()).filter((k) => k.startsWith("audit:"));
  const auditEntries = auditKeys.map((k) => JSON.parse(kv.getStore().get(k)!.value));
  const rateLimitedAudit = auditEntries.find((e) => e.reason === "rate_limited");
  expect(rateLimitedAudit).toBeTruthy();
  expect(rateLimitedAudit.event).toBe("admin.revoke");
  expect(rateLimitedAudit.ok).toBe(false);
  expect(rateLimitedAudit.grantId).toBe("");
});

test("admin revoke: invalid body (regex) returns 400", async () => {
  const kv = new MockKV();

  const mockProvider: OAuthHelpers = {
    revokeGrant: async () => {},
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

  const env: AuthEnv = {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "test-pass",
    COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length",
    ADMIN_REVOKE_TOKEN: "tok",
    OAUTH_PROVIDER: mockProvider,
  };

  const req = new Request("https://example.com/admin/revoke", {
    method: "POST",
    headers: {
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ grantId: "short" }),
  });

  const res = await authorizeApp.fetch(req, env);

  expect(res.status).toBe(400);
  const data = await res.json() as { error: string };
  expect(data.error).toBeTruthy();
});

test("admin revoke: invalid JSON returns 400", async () => {
  const kv = new MockKV();

  const mockProvider: OAuthHelpers = {
    revokeGrant: async () => {},
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

  const env: AuthEnv = {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "test-pass",
    COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length",
    ADMIN_REVOKE_TOKEN: "tok",
    OAUTH_PROVIDER: mockProvider,
  };

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
  const kv = new MockKV();

  const mockProvider: OAuthHelpers = {
    revokeGrant: async () => {},
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

  const env: AuthEnv = {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "test-pass",
    COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length",
    ADMIN_REVOKE_TOKEN: "tok",
    OAUTH_PROVIDER: mockProvider,
  };

  const req = new Request("https://example.com/admin/revoke", {
    method: "POST",
    headers: {
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });

  const res = await authorizeApp.fetch(req, env);

  expect(res.status).toBe(400);
  const data = await res.json() as { error: string };
  expect(data.error).toBeTruthy();
});

test("admin revoke: provider error returns 500", async () => {
  const kv = new MockKV();

  const mockProvider: OAuthHelpers = {
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

  const env: AuthEnv = {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "test-pass",
    COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length",
    ADMIN_REVOKE_TOKEN: "tok",
    OAUTH_PROVIDER: mockProvider,
  };

  const req = new Request("https://example.com/admin/revoke", {
    method: "POST",
    headers: {
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ grantId: "abcdefghijklmnopqrst" }),
  });

  const res = await authorizeApp.fetch(req, env);

  expect(res.status).toBe(500);
  const data = await res.json();
  expect(data).toEqual({ error: "revoke failed" });

  // Verify audit was written with provider_error
  const auditKeys = Array.from(kv.getStore().keys()).filter((k) => k.startsWith("audit:"));
  expect(auditKeys.length).toBe(1);
  const auditEntry = JSON.parse(kv.getStore().get(auditKeys[0]!)!.value);
  expect(auditEntry.event).toBe("admin.revoke");
  expect(auditEntry.ok).toBe(false);
  expect(auditEntry.reason).toBe("provider_error");
  expect(auditEntry.grantId).toBe("abcdefghijklmnopqrst");
});

test("admin revoke: IP fallback to 'unknown' when CF-Connecting-IP missing", async () => {
  const kv = new MockKV();
  const revokeGrantCalls: Array<{ grantId: string; userId: string }> = [];

  const mockProvider: OAuthHelpers = {
    revokeGrant: async (grantId: string, userId: string) => {
      revokeGrantCalls.push({ grantId, userId });
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

  const env: AuthEnv = {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "test-pass",
    COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length",
    ADMIN_REVOKE_TOKEN: "tok",
    OAUTH_PROVIDER: mockProvider,
  };

  const req = new Request("https://example.com/admin/revoke", {
    method: "POST",
    headers: {
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
      // No CF-Connecting-IP header
    },
    body: JSON.stringify({ grantId: "abcdefghijklmnopqrst" }),
  });

  const res = await authorizeApp.fetch(req, env);

  expect(res.status).toBe(200);

  // Verify rate limit key uses "unknown"
  const rateLimitKey = kv.getStore().get("rl:revoke:unknown");
  expect(rateLimitKey).toBeTruthy();
  expect(rateLimitKey?.value).toBe("1");
});

test("admin revoke: GET request returns 404", async () => {
  const kv = new MockKV();

  const mockProvider: OAuthHelpers = {
    revokeGrant: async () => {},
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

  const env: AuthEnv = {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "test-pass",
    COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length",
    ADMIN_REVOKE_TOKEN: "tok",
    OAUTH_PROVIDER: mockProvider,
  };

  const req = new Request("https://example.com/admin/revoke", {
    method: "GET",
    headers: {
      Authorization: "Bearer tok",
    },
  });

  const res = await authorizeApp.fetch(req, env);

  expect(res.status).toBe(404);
  expect(await res.text()).toBe("Not Found");
});
