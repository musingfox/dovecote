/**
 * authorize-missing-client-id.test.ts — Guard: missing client_id → 400 (turn-24).
 *
 * Cases:
 *   MC-A: GET /authorize missing client_id → 400 {"error":"invalid_redirect_uri"}
 *   MC-B: GET /oidc/redirect missing client_id → 400 {"error":"invalid_redirect_uri"}
 *   MC-C: Has client_id + registered redirect → still 302
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
const CLIENT_STATE = "st123";
const CODE_CHALLENGE = "cc-abc";
const CODE_CHALLENGE_METHOD = "S256";
const STATE_SECRET = "s".repeat(32);
const EVIL_REDIRECT = "https://evil.example/cb";
const GOOD_REDIRECT = "https://client.example/callback";

function makeProvider(behavior: "missing_client" | "ok"): OAuthHelpers {
  return {
    parseAuthRequest: async (_req: Request) => {
      if (behavior === "missing_client") {
        return {
          clientId: "",
          redirectUri: EVIL_REDIRECT,
          state: CLIENT_STATE,
          scope: [],
          responseType: "code",
          codeChallenge: CODE_CHALLENGE,
          codeChallengeMethod: CODE_CHALLENGE_METHOD,
        } as any;
      }
      return {
        clientId: DOWNSTREAM_CLIENT_ID,
        redirectUri: GOOD_REDIRECT,
        state: CLIENT_STATE,
        scope: ["dovecote:notify"],
        responseType: "code",
        codeChallenge: CODE_CHALLENGE,
        codeChallengeMethod: CODE_CHALLENGE_METHOD,
      } as any;
    },
    completeAuthorization: async (_params: any) => ({
      redirectTo: `${GOOD_REDIRECT}?code=xxx&state=${CLIENT_STATE}`,
    }),
    lookupClient: async () => ({ redirectUris: [GOOD_REDIRECT] } as any),
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

test("MC-A GET /authorize missing client_id → 400 invalid_redirect_uri", async () => {
  const env = makeEnv({ OAUTH_PROVIDER: makeProvider("missing_client") });
  const qs = `response_type=code&redirect_uri=${encodeURIComponent(EVIL_REDIRECT)}&state=${CLIENT_STATE}&code_challenge=${CODE_CHALLENGE}&code_challenge_method=${CODE_CHALLENGE_METHOD}`;
  const req = new Request(`https://dovecote.example/authorize?${qs}`);
  const res = await authorizeApp.fetch(req, env, makeCtx());
  expect(res.status).toBe(400);
  const body = await res.json() as any;
  expect(body.error).toBe("invalid_redirect_uri");
});

test("MC-B GET /oidc/redirect missing client_id → 404 (oidc removed)", async () => {
  const env = makeEnv({ OAUTH_PROVIDER: makeProvider("missing_client") });
  const qs = `response_type=code&redirect_uri=${encodeURIComponent(EVIL_REDIRECT)}&state=${CLIENT_STATE}&code_challenge=${CODE_CHALLENGE}&code_challenge_method=${CODE_CHALLENGE_METHOD}`;
  const req = new Request(`https://dovecote.example/oidc/redirect?${qs}`);
  const res = await authorizeApp.fetch(req, env, makeCtx());
  expect(res.status).toBe(404);
});

test("MC-C valid client_id + registered redirect → 200 form (not 302)", async () => {
  const env = makeEnv({ OAUTH_PROVIDER: makeProvider("ok") });
  const qs = `response_type=code&client_id=${DOWNSTREAM_CLIENT_ID}&redirect_uri=${encodeURIComponent(GOOD_REDIRECT)}&state=${CLIENT_STATE}&code_challenge=${CODE_CHALLENGE}&code_challenge_method=${CODE_CHALLENGE_METHOD}`;
  const req = new Request(`https://dovecote.example/authorize?${qs}`);
  const res = await authorizeApp.fetch(req, env, makeCtx());
  expect(res.status).toBe(200);
  const ct = res.headers.get("content-type") || "";
  expect(ct).toContain("text/html");
  const body = await res.text();
  expect(body).toContain('name="token"');
  expect(body).toContain(`value="${DOWNSTREAM_CLIENT_ID}"`);
});
