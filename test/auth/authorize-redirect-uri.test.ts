/**
 * authorize-redirect-uri.test.ts — committed tests for Phase 4.6 loopback
 * redirect_uri allowlist guard in handleOidcInitiate (turn 22).
 *
 * Allow cases (→ 302):
 *   - loopback IPv4: http://127.0.0.1:3000/callback
 *   - loopback IPv6: http://[::1]:8080/
 *   - loopback path+query: http://127.0.0.1:52000/cb?foo=bar
 *   - registered client URI: https://app.example.com/oauth
 *
 * Reject cases (→ 400 {error:"invalid_redirect_uri"}):
 *   - non-loopback unregistered: https://evil.example.com/callback
 *   - non-loopback http not localhost: http://evil.com/callback
 *   - empty redirectUri
 *   - registered client but URI not in list
 */
import { test, expect } from "bun:test";
import authorizeApp from "../../src/auth/authorize.ts";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { MockKV } from "../helpers/mock-kv.ts";

const ISSUER = "https://idp.example.test";
const AUTHORIZATION_ENDPOINT = "https://idp.example.test/oauth2/authorize";
const JWKS_URI = `${ISSUER}/jwks`;
const AUDIENCE = "rp-audience-test";
const RP_CLIENT_ID = "rp-client-id";
const DOWNSTREAM_CLIENT_ID = "cid";
const STATE_SECRET = "s".repeat(32);

type ClientInfo = { redirectUris: string[] };

function makeProvider(redirectUri: string, clientInfo: ClientInfo | null = null): OAuthHelpers {
  return {
    parseAuthRequest: async (_req: Request) => ({
      clientId: DOWNSTREAM_CLIENT_ID,
      redirectUri,
      state: "state-abc",
      scope: ["dovecote:notify"],
      responseType: "code",
      codeChallenge: "challenge",
      codeChallengeMethod: "S256",
    } as any),
    completeAuthorization: async (_params: any) => ({
      redirectTo: `${redirectUri || "https://dovecote.example/"}?code=xxx&state=state-abc`,
    }),
    lookupClient: async (_clientId: string) => clientInfo as any,
    createClient: async () => ({}) as any,
    listClients: async () => ({ items: [] }),
    updateClient: async () => null,
    deleteClient: async () => {},
    listUserGrants: async () => ({ items: [] }),
    revokeGrant: async () => {},
    unwrapToken: async () => null,
    exchangeToken: async () => ({}) as any,
  };
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    OAUTH_KV: new MockKV() as any,
    OAUTH_PASSWORD: "pw",
    COOKIE_ENCRYPTION_KEY: "cookie-key-32-chars-min-required!",
    HMAC_PEPPER: "pepper",
    OIDC_STATE_SECRET: STATE_SECRET,
    OIDC_ISSUERS: JSON.stringify([
      {
        issuer: ISSUER,
        jwks_uri: JWKS_URI,
        audience: AUDIENCE,
        client_id: RP_CLIENT_ID,
        authorization_endpoint: AUTHORIZATION_ENDPOINT,
      },
    ]),
    TELEGRAM_INSTANCES: undefined,
    DISCORD_INSTANCES: undefined,
    ...overrides,
  } as any;
}

function makeCtx() {
  return { waitUntil: () => {}, passThroughOnException: () => {} } as any;
}

function makeRequest(redirectUri: string) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: DOWNSTREAM_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "dovecote:notify",
    state: "state-abc",
    code_challenge: "challenge",
    code_challenge_method: "S256",
  });
  return new Request(`https://dovecote.example/authorize?${q.toString()}`);
}

// ── Allow: loopback IPv4 ───────────────────────────────────────────────────────

test("allow: loopback IPv4 http://127.0.0.1:3000/callback → 302", async () => {
  const uri = "http://127.0.0.1:3000/callback";
  const env = makeEnv({ OAUTH_PROVIDER: makeProvider(uri, null) });
  const res = await authorizeApp.fetch(makeRequest(uri), env, makeCtx());
  expect(res.status).toBe(302);
});

// ── Allow: loopback IPv6 ───────────────────────────────────────────────────────

test("allow: loopback IPv6 http://[::1]:8080/ → 302", async () => {
  const uri = "http://[::1]:8080/";
  const env = makeEnv({ OAUTH_PROVIDER: makeProvider(uri, null) });
  const res = await authorizeApp.fetch(makeRequest(uri), env, makeCtx());
  expect(res.status).toBe(302);
});

// ── Allow: loopback with path and query ───────────────────────────────────────

test("allow: loopback http://127.0.0.1:52000/cb?foo=bar → 302", async () => {
  const uri = "http://127.0.0.1:52000/cb?foo=bar";
  const env = makeEnv({ OAUTH_PROVIDER: makeProvider(uri, null) });
  const res = await authorizeApp.fetch(makeRequest(uri), env, makeCtx());
  expect(res.status).toBe(302);
});

// ── Allow: registered URI ─────────────────────────────────────────────────────

test("allow: registered URI https://app.example.com/oauth → 302", async () => {
  const uri = "https://app.example.com/oauth";
  const clientInfo: ClientInfo = { redirectUris: ["https://app.example.com/oauth"] };
  const env = makeEnv({ OAUTH_PROVIDER: makeProvider(uri, clientInfo) });
  const res = await authorizeApp.fetch(makeRequest(uri), env, makeCtx());
  expect(res.status).toBe(302);
});

// ── Reject: non-loopback unregistered ─────────────────────────────────────────

test("reject: non-loopback unregistered → 400 {error:invalid_redirect_uri}", async () => {
  const uri = "https://evil.example.com/callback";
  const env = makeEnv({ OAUTH_PROVIDER: makeProvider(uri, null) });
  const res = await authorizeApp.fetch(makeRequest(uri), env, makeCtx());
  expect(res.status).toBe(400);
  const body = await res.json() as any;
  expect(body).toEqual({ error: "invalid_redirect_uri" });
});

// ── Reject: non-loopback http not localhost ───────────────────────────────────

test("reject: non-loopback http evil.com → 400 {error:invalid_redirect_uri}", async () => {
  const uri = "http://evil.com/callback";
  const env = makeEnv({ OAUTH_PROVIDER: makeProvider(uri, null) });
  const res = await authorizeApp.fetch(makeRequest(uri), env, makeCtx());
  expect(res.status).toBe(400);
  const body = await res.json() as any;
  expect(body).toEqual({ error: "invalid_redirect_uri" });
});

// ── Reject: empty redirectUri ─────────────────────────────────────────────────

test("reject: empty redirectUri → 400 {error:invalid_redirect_uri}", async () => {
  const uri = "";
  const env = makeEnv({ OAUTH_PROVIDER: makeProvider(uri, null) });
  const res = await authorizeApp.fetch(
    new Request(`https://dovecote.example/authorize?response_type=code&client_id=${DOWNSTREAM_CLIENT_ID}&scope=dovecote:notify&state=s`),
    env,
    makeCtx(),
  );
  expect(res.status).toBe(400);
  const body = await res.json() as any;
  expect(body).toEqual({ error: "invalid_redirect_uri" });
});

// ── Reject: registered client, URI not in list ────────────────────────────────

test("reject: registered client but mismatch → 400 {error:invalid_redirect_uri}", async () => {
  const uri = "https://evil.example.com/callback";
  const clientInfo: ClientInfo = { redirectUris: ["https://app.example.com/oauth"] };
  const env = makeEnv({ OAUTH_PROVIDER: makeProvider(uri, clientInfo) });
  const res = await authorizeApp.fetch(makeRequest(uri), env, makeCtx());
  expect(res.status).toBe(400);
  const body = await res.json() as any;
  expect(body).toEqual({ error: "invalid_redirect_uri" });
});
