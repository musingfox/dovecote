/**
 * authorize-redirect-validation.test.ts — committed tests for Phase 4.6 try/catch
 * parseAuthRequest error mapping in handleOidcInitiate (turn 23).
 *
 * Library owns all redirect_uri + client validation; handler catch maps:
 *   - throws "Invalid redirect URI" / "Invalid client" → 400 {error:"invalid_redirect_uri"}
 *   - throws anything else (e.g. resource param) → 500 "Internal Server Error" (Hono default)
 *   - returns normally (including loopback port-flexible) → 302 to authorization_endpoint
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

type ParseBehavior =
  | { kind: "ok"; redirectUri: string }
  | { kind: "throw"; message: string };

function makeProvider(behavior: ParseBehavior): OAuthHelpers {
  const redirectUri = behavior.kind === "ok" ? behavior.redirectUri : "https://client.example/cb";
  return {
    parseAuthRequest: async (_req: Request) => {
      if (behavior.kind === "throw") throw new Error(behavior.message);
      return {
        clientId: DOWNSTREAM_CLIENT_ID,
        redirectUri: behavior.redirectUri,
        state: "state-abc",
        scope: ["dovecote:notify"],
        responseType: "code",
        codeChallenge: "challenge",
        codeChallengeMethod: "S256",
      } as any;
    },
    completeAuthorization: async (_params: any) => ({
      redirectTo: `${redirectUri}?code=xxx&state=state-abc`,
    }),
    lookupClient: async (_clientId: string) => ({ redirectUris: [redirectUri] } as any),
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
    HMAC_PEPPER: "pepper",
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

// ── ok path: registered https URI → 302 to authorization_endpoint ─────────────

test("ok: parseAuthRequest returns normally → 200 form (not 302)", async () => {
  const uri = "https://client.example/callback";
  const env = makeEnv({ OAUTH_PROVIDER: makeProvider({ kind: "ok", redirectUri: uri }) });
  const res = await authorizeApp.fetch(makeRequest(uri), env, makeCtx());
  expect(res.status).toBe(200);
  const ct = res.headers.get("content-type") || "";
  expect(ct).toContain("text/html");
  const body = await res.text();
  expect(body).toContain('name="token"');
});

// ── ok path: loopback IPv4 port-flexible → 200 form ────────────────────────────────

test("ok: loopback http://127.0.0.1:9999/cb parseAuthRequest returns normally → 200 form", async () => {
  const uri = "http://127.0.0.1:9999/cb";
  const env = makeEnv({ OAUTH_PROVIDER: makeProvider({ kind: "ok", redirectUri: uri }) });
  const res = await authorizeApp.fetch(makeRequest(uri), env, makeCtx());
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain('name="token"');
});

// ── ok path: localhost port-flexible → 200 form ────────────────────────────────────

test("ok: localhost http://localhost:9999/cb parseAuthRequest returns normally → 200 form", async () => {
  const uri = "http://localhost:9999/cb";
  const env = makeEnv({ OAUTH_PROVIDER: makeProvider({ kind: "ok", redirectUri: uri }) });
  const res = await authorizeApp.fetch(makeRequest(uri), env, makeCtx());
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain('name="token"');
});

// ── redirect error: "Invalid redirect URI" → 400 {error:"invalid_redirect_uri"} ──

test("redirect error: throws 'Invalid redirect URI' → 400 invalid_redirect_uri", async () => {
  const env = makeEnv({
    OAUTH_PROVIDER: makeProvider({
      kind: "throw",
      message: "Invalid redirect URI. The redirect URI provided does not match any registered URI for this client.",
    }),
  });
  const res = await authorizeApp.fetch(makeRequest("https://evil.example.com/cb"), env, makeCtx());
  expect(res.status).toBe(400);
  const body = await res.json() as any;
  expect(body.error).toBe("invalid_redirect_uri");
});

// ── client error: "Invalid client" → 400 {error:"invalid_redirect_uri"} ─────

test("client error: throws 'Invalid client' → 400 invalid_redirect_uri", async () => {
  const env = makeEnv({
    OAUTH_PROVIDER: makeProvider({
      kind: "throw",
      message: "Invalid client. The clientId provided does not match to this client.",
    }),
  });
  const res = await authorizeApp.fetch(makeRequest("https://client.example/cb"), env, makeCtx());
  expect(res.status).toBe(400);
  const body = await res.json() as any;
  expect(body.error).toBe("invalid_redirect_uri");
});

// ── scheme error: bare "Invalid redirect URI" → 400 {error:"invalid_redirect_uri"} ──

test("scheme error: throws bare 'Invalid redirect URI' → 400 invalid_redirect_uri", async () => {
  const env = makeEnv({
    OAUTH_PROVIDER: makeProvider({
      kind: "throw",
      message: "Invalid redirect URI",
    }),
  });
  const res = await authorizeApp.fetch(makeRequest("javascript:alert(1)"), env, makeCtx());
  expect(res.status).toBe(400);
  const body = await res.json() as any;
  expect(body.error).toBe("invalid_redirect_uri");
});

// ── non-redirect error: resource param error → 500 plain "Internal Server Error" ──

test("non-redirect error: throws resource-param message → 500 plain text Internal Server Error", async () => {
  const env = makeEnv({
    OAUTH_PROVIDER: makeProvider({
      kind: "throw",
      message: "The resource parameter must be a valid absolute URI without a fragment",
    }),
  });
  const res = await authorizeApp.fetch(makeRequest("https://client.example/cb"), env, makeCtx());
  expect(res.status).toBe(500);
  const text = await res.text();
  expect(text).toBe("Internal Server Error");
});
