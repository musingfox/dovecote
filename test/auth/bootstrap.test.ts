import { test, expect } from "bun:test";
import authorizeApp from "../../src/auth/authorize.js";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../../src/types.js";
import { MockKV } from "../helpers/mock-kv.js";

interface AuthEnv extends Env {
  OAUTH_PROVIDER: OAuthHelpers;
}

test("bootstrap: flag absent returns 404 plain text, no audit", async () => {
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
    HMAC_PEPPER: "test-pepper",
    ADMIN_REVOKE_TOKEN: "tok",
    OAUTH_PROVIDER: mockProvider,
    // ENABLE_CLIENT_BOOTSTRAP not set
  };

  const req = new Request("https://example.com/admin/bootstrap-client", {
    method: "POST",
    headers: {
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ clientName: "app", redirectUris: ["https://example.com/cb"] }),
  });

  const res = await authorizeApp.fetch(req, env);

  expect(res.status).toBe(404);
  const text = await res.text();
  expect(text).toBe("Not Found");

  // Verify no audit was written
  const auditKeys = Array.from(kv.getStore().keys()).filter((k) => k.startsWith("audit:"));
  expect(auditKeys.length).toBe(0);
});

test("bootstrap: flag=0 returns 404 plain text", async () => {
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
    HMAC_PEPPER: "test-pepper",
    ADMIN_REVOKE_TOKEN: "tok",
    OAUTH_PROVIDER: mockProvider,
    ENABLE_CLIENT_BOOTSTRAP: "0",
  };

  const req = new Request("https://example.com/admin/bootstrap-client", {
    method: "POST",
    headers: {
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ clientName: "app", redirectUris: ["https://example.com/cb"] }),
  });

  const res = await authorizeApp.fetch(req, env);

  expect(res.status).toBe(404);
  const text = await res.text();
  expect(text).toBe("Not Found");
});

test("bootstrap: flag=1, no Authorization returns 401 json", async () => {
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
    HMAC_PEPPER: "test-pepper",
    ADMIN_REVOKE_TOKEN: "tok",
    OAUTH_PROVIDER: mockProvider,
    ENABLE_CLIENT_BOOTSTRAP: "1",
  };

  const req = new Request("https://example.com/admin/bootstrap-client", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ clientName: "app", redirectUris: ["https://example.com/cb"] }),
  });

  const res = await authorizeApp.fetch(req, env);

  expect(res.status).toBe(401);
  const data = await res.json();
  expect(data).toEqual({ error: "unauthorized" });
});

test("bootstrap: flag=1, Authorization: Basic xxx returns 401 json", async () => {
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
    HMAC_PEPPER: "test-pepper",
    ADMIN_REVOKE_TOKEN: "tok",
    OAUTH_PROVIDER: mockProvider,
    ENABLE_CLIENT_BOOTSTRAP: "1",
  };

  const req = new Request("https://example.com/admin/bootstrap-client", {
    method: "POST",
    headers: {
      Authorization: "Basic xxx",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ clientName: "app", redirectUris: ["https://example.com/cb"] }),
  });

  const res = await authorizeApp.fetch(req, env);

  expect(res.status).toBe(401);
  const data = await res.json();
  expect(data).toEqual({ error: "unauthorized" });
});

test("bootstrap: flag=1, wrong token returns 401 json, audit auth_failed", async () => {
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
    HMAC_PEPPER: "test-pepper",
    ADMIN_REVOKE_TOKEN: "tok",
    OAUTH_PROVIDER: mockProvider,
    ENABLE_CLIENT_BOOTSTRAP: "1",
  };

  const req = new Request("https://example.com/admin/bootstrap-client", {
    method: "POST",
    headers: {
      Authorization: "Bearer wrong",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ clientName: "app", redirectUris: ["https://example.com/cb"] }),
  });

  const res = await authorizeApp.fetch(req, env);

  expect(res.status).toBe(401);
  const data = await res.json();
  expect(data).toEqual({ error: "unauthorized" });

  // Verify audit was written with auth_failed
  const auditKeys = Array.from(kv.getStore().keys()).filter((k) => k.startsWith("audit:"));
  expect(auditKeys.length).toBe(1);
  const auditEntry = JSON.parse(kv.getStore().get(auditKeys[0]!)!.value);
  expect(auditEntry.event).toBe("admin.bootstrap");
  expect(auditEntry.ok).toBe(false);
  expect(auditEntry.reason).toBe("auth_failed");
});

test("bootstrap: flag=1, correct token, 6th call same IP returns 429 with Retry-After:60, audit rate_limited", async () => {
  const kv = new MockKV();

  const mockProvider: OAuthHelpers = {
    revokeGrant: async () => {},
    parseAuthRequest: async () => ({} as any),
    completeAuthorization: async () => ({} as any),
    lookupClient: async () => null,
    createClient: async () => ({ clientId: "abc123" } as any),
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
    HMAC_PEPPER: "test-pepper",
    ADMIN_REVOKE_TOKEN: "tok",
    OAUTH_PROVIDER: mockProvider,
    ENABLE_CLIENT_BOOTSTRAP: "1",
  };

  // Make 5 successful requests
  for (let i = 0; i < 5; i++) {
    const req = new Request("https://example.com/admin/bootstrap-client", {
      method: "POST",
      headers: {
        Authorization: "Bearer tok",
        "Content-Type": "application/json",
        "CF-Connecting-IP": "1.2.3.4",
      },
      body: JSON.stringify({ clientName: `app${i}`, redirectUris: ["https://example.com/cb"] }),
    });

    const res = await authorizeApp.fetch(req, env);
    expect(res.status).toBe(200);
  }

  // 6th request should be rate limited
  const req6 = new Request("https://example.com/admin/bootstrap-client", {
    method: "POST",
    headers: {
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
      "CF-Connecting-IP": "1.2.3.4",
    },
    body: JSON.stringify({ clientName: "app6", redirectUris: ["https://example.com/cb"] }),
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
  expect(rateLimitedAudit.event).toBe("admin.bootstrap");
  expect(rateLimitedAudit.ok).toBe(false);
  expect(rateLimitedAudit.clientName).toBe("");
});

test("bootstrap: flag=1, correct token, body not-json returns 400 Invalid JSON, audit invalid_json", async () => {
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
    HMAC_PEPPER: "test-pepper",
    ADMIN_REVOKE_TOKEN: "tok",
    OAUTH_PROVIDER: mockProvider,
    ENABLE_CLIENT_BOOTSTRAP: "1",
  };

  const req = new Request("https://example.com/admin/bootstrap-client", {
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

  // Verify audit was written with invalid_json
  const auditKeys = Array.from(kv.getStore().keys()).filter((k) => k.startsWith("audit:"));
  expect(auditKeys.length).toBe(1);
  const auditEntry = JSON.parse(kv.getStore().get(auditKeys[0]!)!.value);
  expect(auditEntry.event).toBe("admin.bootstrap");
  expect(auditEntry.ok).toBe(false);
  expect(auditEntry.reason).toBe("invalid_json");
});

test("bootstrap: flag=1, correct token, missing clientName returns 400, audit invalid_body", async () => {
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
    HMAC_PEPPER: "test-pepper",
    ADMIN_REVOKE_TOKEN: "tok",
    OAUTH_PROVIDER: mockProvider,
    ENABLE_CLIENT_BOOTSTRAP: "1",
  };

  const req = new Request("https://example.com/admin/bootstrap-client", {
    method: "POST",
    headers: {
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ redirectUris: ["https://x.com/cb"] }),
  });

  const res = await authorizeApp.fetch(req, env);

  expect(res.status).toBe(400);
  const data = await res.json() as { error: string };
  expect(data.error).toBeTruthy();

  // Verify audit was written with invalid_body
  const auditKeys = Array.from(kv.getStore().keys()).filter((k) => k.startsWith("audit:"));
  expect(auditKeys.length).toBe(1);
  const auditEntry = JSON.parse(kv.getStore().get(auditKeys[0]!)!.value);
  expect(auditEntry.event).toBe("admin.bootstrap");
  expect(auditEntry.ok).toBe(false);
  expect(auditEntry.reason).toBe("invalid_body");
});

test("bootstrap: flag=1, correct token, empty redirectUris returns 400, audit invalid_body", async () => {
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
    HMAC_PEPPER: "test-pepper",
    ADMIN_REVOKE_TOKEN: "tok",
    OAUTH_PROVIDER: mockProvider,
    ENABLE_CLIENT_BOOTSTRAP: "1",
  };

  const req = new Request("https://example.com/admin/bootstrap-client", {
    method: "POST",
    headers: {
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ clientName: "app", redirectUris: [] }),
  });

  const res = await authorizeApp.fetch(req, env);

  expect(res.status).toBe(400);
  const data = await res.json() as { error: string };
  expect(data.error).toBeTruthy();

  // Verify audit was written with invalid_body
  const auditKeys = Array.from(kv.getStore().keys()).filter((k) => k.startsWith("audit:"));
  expect(auditKeys.length).toBe(1);
  const auditEntry = JSON.parse(kv.getStore().get(auditKeys[0]!)!.value);
  expect(auditEntry.event).toBe("admin.bootstrap");
  expect(auditEntry.ok).toBe(false);
  expect(auditEntry.reason).toBe("invalid_body");
});

test("bootstrap: flag=1, correct token, valid body, mock createClient throws returns 500 bootstrap failed, audit provider_error", async () => {
  const kv = new MockKV();

  const mockProvider: OAuthHelpers = {
    revokeGrant: async () => {},
    parseAuthRequest: async () => ({} as any),
    completeAuthorization: async () => ({} as any),
    lookupClient: async () => null,
    createClient: async () => {
      throw new Error("Provider error");
    },
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
    HMAC_PEPPER: "test-pepper",
    ADMIN_REVOKE_TOKEN: "tok",
    OAUTH_PROVIDER: mockProvider,
    ENABLE_CLIENT_BOOTSTRAP: "1",
  };

  const req = new Request("https://example.com/admin/bootstrap-client", {
    method: "POST",
    headers: {
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ clientName: "my-app", redirectUris: ["https://example.com/cb"] }),
  });

  const res = await authorizeApp.fetch(req, env);

  expect(res.status).toBe(500);
  const data = await res.json();
  expect(data).toEqual({ error: "bootstrap failed" });

  // Verify audit was written with provider_error
  const auditKeys = Array.from(kv.getStore().keys()).filter((k) => k.startsWith("audit:"));
  expect(auditKeys.length).toBe(1);
  const auditEntry = JSON.parse(kv.getStore().get(auditKeys[0]!)!.value);
  expect(auditEntry.event).toBe("admin.bootstrap");
  expect(auditEntry.ok).toBe(false);
  expect(auditEntry.reason).toBe("provider_error");
  expect(auditEntry.clientName).toBe("my-app");
});

test("bootstrap: flag=1, correct token, valid body, returns 200 with client_id, audit success, KV has bootstrap key", async () => {
  const kv = new MockKV();

  const mockProvider: OAuthHelpers = {
    revokeGrant: async () => {},
    parseAuthRequest: async () => ({} as any),
    completeAuthorization: async () => ({} as any),
    lookupClient: async () => null,
    createClient: async () => ({ clientId: "abc123" } as any),
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
    HMAC_PEPPER: "test-pepper",
    ADMIN_REVOKE_TOKEN: "tok",
    OAUTH_PROVIDER: mockProvider,
    ENABLE_CLIENT_BOOTSTRAP: "1",
  };

  const req = new Request("https://example.com/admin/bootstrap-client", {
    method: "POST",
    headers: {
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
      "CF-Connecting-IP": "1.2.3.4",
    },
    body: JSON.stringify({ clientName: "my-app", redirectUris: ["https://example.com/cb"] }),
  });

  const res = await authorizeApp.fetch(req, env);

  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data).toEqual({ client_id: "abc123" });

  // Verify audit was written with success
  const auditKeys = Array.from(kv.getStore().keys()).filter((k) => k.startsWith("audit:"));
  expect(auditKeys.length).toBe(1);
  const auditEntry = JSON.parse(kv.getStore().get(auditKeys[0]!)!.value);
  expect(auditEntry.event).toBe("admin.bootstrap");
  expect(auditEntry.ok).toBe(true);
  expect(auditEntry.clientName).toBe("my-app");

  // Verify KV has bootstrap namespace key (NOT revoke)
  const bootstrapKey = kv.getStore().get("rl:bootstrap:1.2.3.4");
  expect(bootstrapKey).toBeTruthy();
  expect(bootstrapKey?.value).toBe("1");

  // Verify no revoke key
  const revokeKey = kv.getStore().get("rl:revoke:1.2.3.4");
  expect(revokeKey).toBeUndefined();
});
