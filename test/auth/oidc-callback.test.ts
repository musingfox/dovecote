/**
 * E14 — committed test: GET /oidc/callback happy path → 302.
 *
 * Locks reachability and the happy path against silent regression.
 * Mocks globalThis.fetch for token_endpoint and jwks_uri.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import * as jose from "jose";
import authorizeApp from "../../src/auth/authorize.ts";
import { encodeOidcState } from "../../src/auth/oidc-rp-state.ts";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { MockKV } from "../helpers/mock-kv.ts";

const ISSUER = "https://issuer.example.test";
const AUDIENCE = "aud-test-1";
const SUB = "alice";
const STATE_SECRET = "s".repeat(32);
const CLIENT_STATE = "client-state-abc";
const RP_NONCE = "rp-nonce-e14";
const TOKEN_ENDPOINT = `${ISSUER}/token`;
const JWKS_URI = `${ISSUER}/jwks`;
const REDIRECT_URI = "https://dovecote.example/oidc/callback";

let kp: jose.GenerateKeyPairResult;
let pubJwk: jose.JWK;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  kp = await jose.generateKeyPair("RS256", { extractable: true });
  pubJwk = await jose.exportJWK(kp.publicKey);
  pubJwk.kid = "e14-kid";
  pubJwk.alg = "RS256";
  pubJwk.use = "sig";

  (globalThis as any).fetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url === TOKEN_ENDPOINT || url.startsWith(TOKEN_ENDPOINT + "?")) {
      const now = Math.floor(Date.now() / 1000);
      const idToken = await new jose.SignJWT({ nonce: RP_NONCE })
        .setProtectedHeader({ alg: "RS256", kid: "e14-kid" })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setSubject(SUB)
        .setIssuedAt(now - 60)
        .setExpirationTime(now + 3600)
        .sign(kp.privateKey);
      return new Response(JSON.stringify({ id_token: idToken }), { status: 200 });
    }
    if (url === JWKS_URI || url.startsWith(JWKS_URI + "?")) {
      return new Response(JSON.stringify({ keys: [pubJwk] }), { status: 200 });
    }
    return originalFetch(input as any, init);
  };
});

afterAll(() => {
  (globalThis as any).fetch = originalFetch;
});

function makeProvider(): OAuthHelpers {
  return {
    parseAuthRequest: async () => ({ clientId: "cid", redirectUri: REDIRECT_URI, state: CLIENT_STATE, scope: ["dovecote:notify"], responseType: "code" } as any),
    completeAuthorization: async (params: any) => {
      const code = "dvc_" + "x".repeat(32);
      return { redirectTo: `${REDIRECT_URI}?code=${code}&state=${CLIENT_STATE}` };
    },
    lookupClient: async () => null,
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

test("E14 happy path: valid state+code → 302 with code=dvc_ and state=clientstate", async () => {
  const kv = new MockKV();
  const env = {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "pw",
    COOKIE_ENCRYPTION_KEY: "cookie-key-32-chars-min-required!",
    HMAC_PEPPER: "pepper",
    OIDC_STATE_SECRET: STATE_SECRET,
    OIDC_ISSUERS: JSON.stringify([
      { issuer: ISSUER, jwks_uri: JWKS_URI, audience: AUDIENCE },
    ]),
    OAUTH_PROVIDER: makeProvider(),
    TELEGRAM_INSTANCES: undefined,
    DISCORD_INSTANCES: undefined,
  } as any;

  const stateToken = await encodeOidcState(
    {
      clientId: "cid",
      redirectUri: REDIRECT_URI,
      scope: ["dovecote:notify"],
      state: CLIENT_STATE,
      nonce: RP_NONCE,
      codeChallenge: "ch",
      codeChallengeMethod: "S256",
      responseType: "code",
    },
    STATE_SECRET,
  );

  const req = new Request(
    `https://dovecote.example/oidc/callback?code=upstream-code&state=${encodeURIComponent(stateToken)}`,
  );

  const res = await authorizeApp.fetch(
    req,
    env,
    { waitUntil: () => {}, passThroughOnException: () => {} } as any,
  );

  expect(res.status).toBe(302);
  const loc = res.headers.get("Location") ?? "";
  expect(loc).toContain("code=dvc_");
  expect(loc).toContain(`state=${CLIENT_STATE}`);
});
