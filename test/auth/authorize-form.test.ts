import { test, expect } from "bun:test";
import authorizeApp from "../../src/auth/authorize.js";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../../src/types.js";
import { MockKV } from "../helpers/mock-kv.js";

interface AuthEnv extends Env {
  OAUTH_PROVIDER: OAuthHelpers;
}

function makeProvider(knowsClient = true): OAuthHelpers {
  return {
    parseAuthRequest: async () => ({ clientId: "test-client", redirectUri: "https://client.example/cb", state: "abc", scope: ["dovecote:notify"], responseType: "code" } as any),
    completeAuthorization: async () => ({ redirectTo: "https://client.example/cb?code=xyz&state=abc" } as any),
    lookupClient: async (clientId: string) => knowsClient ? ({ clientId, redirectUris: ["https://client.example/cb"] } as any) : null,
    createClient: async () => ({} as any),
    listClients: async () => ({ items: [] }),
    updateClient: async () => null,
    deleteClient: async () => {},
    listUserGrants: async () => ({ items: [] }),
    revokeGrant: async () => {},
    unwrapToken: async () => null,
    exchangeToken: async () => ({} as any),
  };
}

function makeEnv(overrides: Partial<AuthEnv> = {}): AuthEnv {
  const kv = new MockKV();
  return {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "pw",
    COOKIE_ENCRYPTION_KEY: "k".repeat(32),
    HMAC_PEPPER: "pepper",
    OAUTH_PROVIDER: makeProvider(true),
    ...overrides,
  } as AuthEnv;
}

function makeCtx() {
  return { waitUntil: () => {}, passThroughOnException: () => {} } as any;
}

test("AuthorizeFormRender T1: GET /authorize with valid params renders 200 text/html form with name=token action=/authorize and hidden client_id/state", async () => {
  const env = makeEnv();
  const qs = "response_type=code&client_id=test-client&redirect_uri=https%3A%2F%2Fclient.example%2Fcb&state=abc";
  const req = new Request(`https://example.com/authorize?${qs}`);
  const res = await authorizeApp.fetch(req, env, makeCtx());
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(text).toContain('name="token"');
  expect(text).toContain('action="/authorize"');
  expect(text).toContain('name="client_id"');
  expect(text).toContain('value="test-client"');
  expect(text).toContain('name="state"');
  expect(text).toContain('value="abc"');
});

test("AuthorizeFormRender T2: GET /authorize without client_id returns 400 json error=invalid_redirect_uri", async () => {
  const env = makeEnv();
  const req = new Request("https://example.com/authorize?response_type=code&redirect_uri=https%3A%2F%2Fclient.example%2Fcb&state=abc");
  const res = await authorizeApp.fetch(req, env, makeCtx());
  expect(res.status).toBe(400);
  const body = await res.json() as any;
  expect(body.error).toBe("invalid_redirect_uri");
});

test("AuthorizeFormRender T3: GET /authorize when env missing OAUTH_PROVIDER returns 500 json error=no_provider", async () => {
  const env = makeEnv({ OAUTH_PROVIDER: undefined as any });
  const qs = "response_type=code&client_id=test-client&redirect_uri=https%3A%2F%2Fclient.example%2Fcb&state=abc";
  const req = new Request(`https://example.com/authorize?${qs}`);
  const res = await authorizeApp.fetch(req, env, makeCtx());
  expect(res.status).toBe(500);
  const body = await res.json() as any;
  expect(body.error).toBe("no_provider");
});
