/**
 * authorize-oidc.test.ts — E1–E4 committed tests for GET /authorize OIDC redirect (turn-17).
 *
 * After BUILD, GET /authorize must redirect to upstream IdP (OIDC), not render HTML form.
 * POST /authorize is retired (404 or 410).
 *
 * Harness mirrors oidc-redirect.test.ts.
 */
import { test, expect } from "bun:test";
import authorizeApp from "../../src/auth/authorize.ts";
// (removed) import { decodeOidcState } from "../../src/auth/oidc-rp-state.ts";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { MockKV } from "../helpers/mock-kv.ts";

// ---- constants ---------------------------------------------------------------

const ISSUER = "https://idp.example.test";
const AUTHORIZATION_ENDPOINT = "https://idp.example.test/oauth2/authorize";
const JWKS_URI = `${ISSUER}/jwks`;
const AUDIENCE = "rp-audience-test";
const RP_CLIENT_ID = "rp-client-id";
const DOWNSTREAM_CLIENT_ID = "cid";
const CLIENT_REDIRECT_URI = "https://client.example/callback";
const CLIENT_STATE = "client-state-xyz";
const CODE_CHALLENGE = "pkce-challenge";
const CODE_CHALLENGE_METHOD = "S256";
const STATE_SECRET = "s".repeat(32);

// ---- helpers -----------------------------------------------------------------

function makeProvider(): OAuthHelpers {
  return {
    parseAuthRequest: async (_req: Request) => {
      return {
        clientId: DOWNSTREAM_CLIENT_ID,
        redirectUri: CLIENT_REDIRECT_URI,
        state: CLIENT_STATE,
        scope: ["dovecote:notify"],
        responseType: "code",
        codeChallenge: CODE_CHALLENGE,
        codeChallengeMethod: CODE_CHALLENGE_METHOD,
      } as any;
    },
    completeAuthorization: async (params: any) => {
      return { redirectTo: `${CLIENT_REDIRECT_URI}?code=xxx&state=${CLIENT_STATE}` };
    },
    lookupClient: async (_clientId: string) => ({ redirectUris: [CLIENT_REDIRECT_URI] } as any),
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

function makeEnv(overrides: Partial<Record<string, unknown>> = {}) {
  const kv = new MockKV();
  return {
    OAUTH_KV: kv as any,
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
    OAUTH_PROVIDER: makeProvider(),
    TELEGRAM_INSTANCES: undefined,
    DISCORD_INSTANCES: undefined,
    ...overrides,
  } as any;
}

function makeCtx() {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as any;
}

function authQuery() {
  return `response_type=code&client_id=${DOWNSTREAM_CLIENT_ID}&redirect_uri=${encodeURIComponent(CLIENT_REDIRECT_URI)}&scope=dovecote:notify&state=${CLIENT_STATE}&code_challenge=${CODE_CHALLENGE}&code_challenge_method=${CODE_CHALLENGE_METHOD}`;
}

// ---- E1: GET /authorize → 302 redirect (not 200 HTML form) -------------------

test("E1a GET /authorize with valid OIDC config → 302 (not 200)", async () => {
  const env = makeEnv();
  const req = new Request(`https://dovecote.example/authorize?${authQuery()}`);
  const res = await authorizeApp.fetch(req, env, makeCtx());
  expect(res.status).toBe(302);
});

test("E1b GET /authorize → Location starts with authorization_endpoint", async () => {
  const env = makeEnv();
  const req = new Request(`https://dovecote.example/authorize?${authQuery()}`);
  const res = await authorizeApp.fetch(req, env, makeCtx());
  expect(res.status).toBe(302);
  const loc = res.headers.get("Location") ?? "";
  expect(loc.startsWith(AUTHORIZATION_ENDPOINT)).toBe(true);
});

test("E1c GET /authorize → Location contains state param (non-empty)", async () => {
  const env = makeEnv();
  const req = new Request(`https://dovecote.example/authorize?${authQuery()}`);
  const res = await authorizeApp.fetch(req, env, makeCtx());
  expect(res.status).toBe(302);
  const loc = res.headers.get("Location") ?? "";
  const params = new URL(loc).searchParams;
  expect((params.get("state") ?? "").length).toBeGreaterThan(0);
});

test("E1d GET /authorize → state decodes to clientId=cid and redirectUri=client redirect", async () => {
  const env = makeEnv();
  const req = new Request(`https://dovecote.example/authorize?${authQuery()}`);
  const res = await authorizeApp.fetch(req, env, makeCtx());
  expect(res.status).toBe(302);
  const loc = res.headers.get("Location") ?? "";
  const params = new URL(loc).searchParams;
  const stateParam = params.get("state") ?? "";
  const decoded = await decodeOidcState(stateParam, STATE_SECRET);
  expect(decoded).not.toBeNull();
  expect(decoded!.clientId).toBe(DOWNSTREAM_CLIENT_ID);
  expect(decoded!.redirectUri).toBe(CLIENT_REDIRECT_URI);
});

test("E1e GET /authorize → Location contains nonce param (non-empty)", async () => {
  const env = makeEnv();
  const req = new Request(`https://dovecote.example/authorize?${authQuery()}`);
  const res = await authorizeApp.fetch(req, env, makeCtx());
  expect(res.status).toBe(302);
  const loc = res.headers.get("Location") ?? "";
  const params = new URL(loc).searchParams;
  expect((params.get("nonce") ?? "").length).toBeGreaterThan(0);
});

// ---- E2: POST /authorize → 404 or 410 (retired) ------------------------------

test("E2 POST /authorize → 404 or 410 (retired)", async () => {
  const env = makeEnv();
  const req = new Request("https://dovecote.example/authorize", {
    method: "POST",
    body: new URLSearchParams({ username: "u", password: "p" }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  const res = await authorizeApp.fetch(req, env, makeCtx());
  expect([404, 410]).toContain(res.status);
});

// ---- E3: GET /authorize body contains no HTML form ---------------------------

test("E3a GET /authorize → status != 200 (must not return HTML form)", async () => {
  const env = makeEnv();
  const req = new Request(`https://dovecote.example/authorize?${authQuery()}`);
  const res = await authorizeApp.fetch(req, env, makeCtx());
  expect(res.status).not.toBe(200);
});

test("E3b GET /authorize → body text has no <form", async () => {
  const env = makeEnv();
  const req = new Request(`https://dovecote.example/authorize?${authQuery()}`);
  const res = await authorizeApp.fetch(req, env, makeCtx());
  const text = await res.text();
  expect(text).not.toContain("<form");
});

test("E3c GET /authorize → body text has no name=\"password\"", async () => {
  const env = makeEnv();
  const req = new Request(`https://dovecote.example/authorize?${authQuery()}`);
  const res = await authorizeApp.fetch(req, env, makeCtx());
  const text = await res.text();
  expect(text).not.toContain('name="password"');
});

// ---- E4: mis-config → 5xx config_error / no_provider ------------------------

test("E4a OIDC_STATE_SECRET missing → 500 config_error", async () => {
  const env = makeEnv({ OIDC_STATE_SECRET: undefined });
  const req = new Request(`https://dovecote.example/authorize?${authQuery()}`);
  const res = await authorizeApp.fetch(req, env, makeCtx());
  expect(res.status).toBe(500);
  expect((await res.json() as any).error).toBe("config_error");
});

test("E4a OIDC_STATE_SECRET len<32 → 500 config_error", async () => {
  const env = makeEnv({ OIDC_STATE_SECRET: "short" });
  const req = new Request(`https://dovecote.example/authorize?${authQuery()}`);
  const res = await authorizeApp.fetch(req, env, makeCtx());
  expect(res.status).toBe(500);
  expect((await res.json() as any).error).toBe("config_error");
});

test("E4b OIDC_ISSUERS empty array \"[]\" → 500 config_error", async () => {
  const env = makeEnv({ OIDC_ISSUERS: "[]" });
  const req = new Request(`https://dovecote.example/authorize?${authQuery()}`);
  const res = await authorizeApp.fetch(req, env, makeCtx());
  expect(res.status).toBe(500);
  expect((await res.json() as any).error).toBe("config_error");
});

test("E4c issuer missing authorization_endpoint → 500 config_error", async () => {
  const env = makeEnv({
    OIDC_ISSUERS: JSON.stringify([
      { issuer: ISSUER, jwks_uri: JWKS_URI, audience: AUDIENCE, client_id: RP_CLIENT_ID },
      // no authorization_endpoint
    ]),
  });
  const req = new Request(`https://dovecote.example/authorize?${authQuery()}`);
  const res = await authorizeApp.fetch(req, env, makeCtx());
  expect(res.status).toBe(500);
  expect((await res.json() as any).error).toBe("config_error");
});

test("E4d OAUTH_PROVIDER undefined → 500 no_provider", async () => {
  const env = makeEnv({ OAUTH_PROVIDER: undefined });
  const req = new Request(`https://dovecote.example/authorize?${authQuery()}`);
  const res = await authorizeApp.fetch(req, env, makeCtx());
  expect(res.status).toBe(500);
  expect((await res.json() as any).error).toBe("no_provider");
});
