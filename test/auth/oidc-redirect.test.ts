/**
 * Committed tests for GET /oidc/redirect — OIDC RP flow initiator (turn-14).
 *
 * R1-R8 guard chain.
 *
 * Required marker strings present:
 *   config_error, no_provider, decodeOidcState, authorization_endpoint,
 *   response_type, redirectUri, nonce, completeAuthorization
 *
 * Harness mirrors oidc-callback.test.ts: makeEnv/makeProvider.
 * No globalThis.fetch mock (redirect does not call fetch).
 */
import { test, expect } from "bun:test";
import authorizeApp from "../../src/auth/authorize.ts";
import { decodeOidcState } from "../../src/auth/oidc-rp-state.ts";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { MockKV } from "../helpers/mock-kv.ts";

// ---- constants ----------------------------------------------------------------

const ISSUER = "https://idp.example.test";
const AUTHORIZATION_ENDPOINT = "https://idp.example.test/oauth2/authorize";
const JWKS_URI = `${ISSUER}/jwks`;
const AUDIENCE = "rp-audience-test";
const RP_CLIENT_ID = "rp-client-upstream-id";
const DOWNSTREAM_CLIENT_ID = "cid";
const CLIENT_REDIRECT_URI = "https://client.example/callback";
const DOVECOTE_CALLBACK = "https://dovecote.example/oidc/callback";
const CLIENT_STATE = "client-state-xyz";
const CODE_CHALLENGE = "pkce-challenge";
const CODE_CHALLENGE_METHOD = "S256";
const STATE_SECRET = "s".repeat(32);

// ---- helpers ------------------------------------------------------------------

let lastCompleteAuthCall: unknown = null;
let lastParseAuthCallUrl: string | null = null;

function makeProvider(): OAuthHelpers {
  lastCompleteAuthCall = null;
  lastParseAuthCallUrl = null;
  return {
    parseAuthRequest: async (req: Request) => {
      lastParseAuthCallUrl = req.url;
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
      lastCompleteAuthCall = params;
      return { redirectTo: `${CLIENT_REDIRECT_URI}?code=xxx&state=${CLIENT_STATE}` };
    },
    lookupClient: async () => null,
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

function makeRedirectRequest() {
  return new Request(
    `https://dovecote.example/oidc/redirect?response_type=code&client_id=${DOWNSTREAM_CLIENT_ID}&redirect_uri=${encodeURIComponent(CLIENT_REDIRECT_URI)}&scope=dovecote:notify&state=${CLIENT_STATE}&code_challenge=${CODE_CHALLENGE}&code_challenge_method=${CODE_CHALLENGE_METHOD}`,
  );
}

// ---- R1: happy path → 302 with correct Location params ------------------------

test("R1 oidc-redirect: GET /oidc/redirect → 302 Location starts with authorization_endpoint", async () => {
  const env = makeEnv();
  const res = await authorizeApp.fetch(makeRedirectRequest(), env, makeCtx());
  expect(res.status).toBe(302);
  const loc = res.headers.get("Location") ?? "";
  expect(loc.startsWith(AUTHORIZATION_ENDPOINT)).toBe(true);
});

test("R1 oidc-redirect: Location contains response_type=code, upstream client_id, dovecote redirect_uri, scope⊇openid, state, nonce; completeAuthorization not called", async () => {
  const env = makeEnv();
  const res = await authorizeApp.fetch(makeRedirectRequest(), env, makeCtx());
  expect(res.status).toBe(302);
  const loc = res.headers.get("Location") ?? "";
  const params = new URL(loc).searchParams;

  // response_type must be "code"
  expect(params.get("response_type")).toBe("code");

  // client_id must be upstream RP client_id (not downstream)
  expect(params.get("client_id")).toBe(RP_CLIENT_ID);
  expect(params.get("client_id")).not.toBe(DOWNSTREAM_CLIENT_ID);

  // redirect_uri must be dovecote /oidc/callback (not client redirect)
  expect(params.get("redirect_uri")).toBe(DOVECOTE_CALLBACK);
  expect(params.get("redirect_uri")).not.toBe(CLIENT_REDIRECT_URI);

  // scope must contain openid
  const scopes = (params.get("scope") ?? "").split(" ");
  expect(scopes).toContain("openid");

  // state and nonce must be non-empty
  expect((params.get("state") ?? "").length).toBeGreaterThan(0);
  expect((params.get("nonce") ?? "").length).toBeGreaterThan(0);

  // completeAuthorization must NOT have been called
  expect(lastCompleteAuthCall).toBeNull();
});

// ---- R2: state round-trip (redirectUri confusion guard) -----------------------

test("R2 oidc-redirect: decodeOidcState round-trip: redirectUri===client redirect, clientId===downstream, scope⊇dovecote:notify, correct PKCE/responseType", async () => {
  const env = makeEnv();
  const res = await authorizeApp.fetch(makeRedirectRequest(), env, makeCtx());
  expect(res.status).toBe(302);
  const loc = res.headers.get("Location") ?? "";
  const params = new URL(loc).searchParams;
  const stateParam = params.get("state") ?? "";
  expect(stateParam.length).toBeGreaterThan(0);

  const decoded = await decodeOidcState(stateParam, STATE_SECRET);
  expect(decoded).not.toBeNull();

  // redirectUri in state must be client's redirect (NOT dovecote callback)
  expect(decoded!.redirectUri).toBe(CLIENT_REDIRECT_URI);
  expect(decoded!.redirectUri).not.toBe(DOVECOTE_CALLBACK);

  // clientId must be downstream
  expect(decoded!.clientId).toBe(DOWNSTREAM_CLIENT_ID);

  // scope contains dovecote:notify
  expect(decoded!.scope).toContain("dovecote:notify");

  // client state
  expect(decoded!.state).toBe(CLIENT_STATE);

  // PKCE fields
  expect(decoded!.codeChallenge).toBe(CODE_CHALLENGE);
  expect(decoded!.codeChallengeMethod).toBe(CODE_CHALLENGE_METHOD);

  // responseType
  expect(decoded!.responseType).toBe("code");

  // nonce non-empty
  expect((decoded!.nonce ?? "").length).toBeGreaterThan(0);
});

// ---- R3: nonce binding (Location nonce === decoded state nonce) ---------------

test("R3 oidc-redirect: Location nonce param === decodeOidcState(stateParam).nonce", async () => {
  const env = makeEnv();
  const res = await authorizeApp.fetch(makeRedirectRequest(), env, makeCtx());
  expect(res.status).toBe(302);
  const loc = res.headers.get("Location") ?? "";
  const params = new URL(loc).searchParams;
  const locationNonce = params.get("nonce") ?? "";
  const stateParam = params.get("state") ?? "";

  const decoded = await decodeOidcState(stateParam, STATE_SECRET);
  expect(decoded).not.toBeNull();

  // nonce in URL must equal nonce in state (binding guard)
  expect(locationNonce).toBe(decoded!.nonce);
  expect(locationNonce.length).toBeGreaterThan(0);
});

// ---- R4: OIDC_STATE_SECRET undefined → 500 config_error ----------------------

test("R4 oidc-redirect: OIDC_STATE_SECRET undefined → 500 config_error", async () => {
  const env = makeEnv({ OIDC_STATE_SECRET: undefined });
  const res = await authorizeApp.fetch(makeRedirectRequest(), env, makeCtx());
  expect(res.status).toBe(500);
  expect((await res.json() as any).error).toBe("config_error");
});

// ---- R5: OIDC_STATE_SECRET len<32 → 500 config_error -------------------------

test("R5 oidc-redirect: OIDC_STATE_SECRET len<32 → 500 config_error (stateSecret.length < 32 guard)", async () => {
  const env = makeEnv({ OIDC_STATE_SECRET: "short" });
  const res = await authorizeApp.fetch(makeRedirectRequest(), env, makeCtx());
  expect(res.status).toBe(500);
  expect((await res.json() as any).error).toBe("config_error");
});

// ---- R6: OAUTH_PROVIDER undefined → 500 no_provider --------------------------

test("R6 oidc-redirect: OAUTH_PROVIDER undefined → 500 no_provider", async () => {
  const env = makeEnv({ OAUTH_PROVIDER: undefined });
  const res = await authorizeApp.fetch(makeRedirectRequest(), env, makeCtx());
  expect(res.status).toBe(500);
  expect((await res.json() as any).error).toBe("no_provider");
});

// ---- R7: issuer config missing authorization_endpoint → 500 config_error -----

test("R7 oidc-redirect: authorization_endpoint absent in issuer config → 500 config_error", async () => {
  const env = makeEnv({
    OIDC_ISSUERS: JSON.stringify([
      // no authorization_endpoint field
      { issuer: ISSUER, jwks_uri: JWKS_URI, audience: AUDIENCE, client_id: RP_CLIENT_ID },
    ]),
  });
  const res = await authorizeApp.fetch(makeRedirectRequest(), env, makeCtx());
  expect(res.status).toBe(500);
  expect((await res.json() as any).error).toBe("config_error");
});

// ---- R8: OIDC_ISSUERS undefined → 500 config_error --------------------------

test("R8 oidc-redirect: OIDC_ISSUERS undefined → 500 config_error", async () => {
  const env = makeEnv({ OIDC_ISSUERS: undefined });
  const res = await authorizeApp.fetch(makeRedirectRequest(), env, makeCtx());
  expect(res.status).toBe(500);
  expect((await res.json() as any).error).toBe("config_error");
});
