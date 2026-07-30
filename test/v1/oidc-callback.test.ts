/**
 * OIDC callback committed tests: E2-E14 guard chain.
 *
 * E14 — happy path → 302.
 * E2-E13 + Ebad_aud + Eiat_missing — reject paths with specific error strings.
 * Each reject case asserts:
 *   - HTTP status
 *   - (await res.json()).error === "<string>"
 *   - completeAuthorization was NOT called (lastCompleteAuthCall === null)
 *
 * All 11 required error tokens are present:
 *   missing_params, invalid_state, state_expired, upstream_exchange_failed,
 *   untrusted_issuer, bad_signature, expired_token, nonce_mismatch,
 *   user_resolve_failed, no_provider, config_error
 */
import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import * as jose from "jose";
import authorizeApp from "../../src/auth/authorize.ts";
// (removed) import { encodeOidcState, decodeOidcState } from "../../src/auth/oidc-rp-state.ts";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { MockKV } from "../helpers/mock-kv.ts";

// ---- constants ----------------------------------------------------------------

const ISSUER = "https://issuer.example.test";
const AUDIENCE = "aud-test-1";
const SUB = "alice";
const STATE_SECRET = "s".repeat(32);
const CLIENT_STATE = "client-state-abc";
const RP_NONCE = "rp-nonce-e14";
const TOKEN_ENDPOINT = `${ISSUER}/token`;
const JWKS_URI = `${ISSUER}/jwks`;
// Two distinct URIs: client's redirect (stored in state payload) vs. dovecote's own callback.
const CLIENT_REDIRECT_URI = "https://client.example/callback";
const DOVECOTE_CALLBACK = "https://dovecote.example/oidc/callback";

// ---- key pair (generated once) ------------------------------------------------

let kp: jose.GenerateKeyPairResult;
let pubJwk: jose.JWK;
const originalFetch = globalThis.fetch;

// ---- mutable mock state -------------------------------------------------------

// Each test can override these to simulate different upstream responses.
interface MockConfig {
  /** If set, return this as token_endpoint response (overrides idToken build). */
  tokenResponse?: Response;
  /** If set, use this key pair to sign the id_token (for E9 bad signature). */
  signingKp?: jose.GenerateKeyPairResult;
  /** If set, override iss claim in id_token. */
  iss?: string;
  /** If set, override aud claim in id_token. */
  aud?: string;
  /** If set, set exp to this unix time. */
  exp?: number;
  /** If set, override nonce claim. */
  nonce?: string;
}

let mockConfig: MockConfig = {};

// Captures the last token endpoint POST body for redirect_uri assertions.
let lastExchangeBody: string | null = null;

beforeAll(async () => {
  kp = await jose.generateKeyPair("RS256", { extractable: true });
  pubJwk = await jose.exportJWK(kp.publicKey);
  pubJwk.kid = "e14-kid";
  pubJwk.alg = "RS256";
  pubJwk.use = "sig";

  (globalThis as any).fetch = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;

    if (url === TOKEN_ENDPOINT || url.startsWith(TOKEN_ENDPOINT + "?")) {
      // Capture POST body for redirect_uri assertions.
      lastExchangeBody = (init?.body as string) ?? null;
      // Allow full override first.
      if (mockConfig.tokenResponse) {
        return mockConfig.tokenResponse.clone();
      }
      const now = Math.floor(Date.now() / 1000);
      const sigKp = mockConfig.signingKp ?? kp;
      const builder = new jose.SignJWT({
        nonce: mockConfig.nonce ?? RP_NONCE,
      })
        .setProtectedHeader({ alg: "RS256", kid: "e14-kid" })
        .setIssuer(mockConfig.iss ?? ISSUER)
        .setAudience(mockConfig.aud ?? AUDIENCE)
        .setSubject(SUB)
        .setIssuedAt(now - 60);
      if (mockConfig.exp !== undefined) {
        builder.setExpirationTime(mockConfig.exp);
      } else {
        builder.setExpirationTime(now + 3600);
      }
      const idToken = await builder.sign(sigKp.privateKey);
      return new Response(JSON.stringify({ id_token: idToken }), {
        status: 200,
      });
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

beforeEach(() => {
  mockConfig = {};
});

// ---- helpers ------------------------------------------------------------------

/** Track completeAuthorization calls. Reset to null in each test. */
let lastCompleteAuthCall: unknown = null;

function makeProvider(): OAuthHelpers {
  lastCompleteAuthCall = null;
  return {
    parseAuthRequest: async () =>
      ({
        clientId: "cid",
        redirectUri: CLIENT_REDIRECT_URI,
        state: CLIENT_STATE,
        scope: ["dovecote:notify"],
        responseType: "code",
      }) as any,
    completeAuthorization: async (params: any) => {
      lastCompleteAuthCall = params;
      const code = "dvc_" + "x".repeat(32);
      return { redirectTo: `${CLIENT_REDIRECT_URI}?code=${code}&state=${CLIENT_STATE}` };
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
      { issuer: ISSUER, jwks_uri: JWKS_URI, audience: AUDIENCE },
    ]),
    OAUTH_PROVIDER: makeProvider(),
    TELEGRAM_INSTANCES: undefined,
    DISCORD_INSTANCES: undefined,
    ...overrides,
  } as any;
}

async function makeValidStateToken(overrides: {
  iat?: number;
  nonce?: string;
} = {}) {
  return encodeOidcState(
    {
      clientId: "cid",
      redirectUri: CLIENT_REDIRECT_URI,  // client's redirect stored in state (NOT dovecote callback)
      scope: ["dovecote:notify"],
      state: CLIENT_STATE,
      nonce: overrides.nonce ?? RP_NONCE,
      codeChallenge: "ch",
      codeChallengeMethod: "S256",
      responseType: "code",
      ...(overrides.iat !== undefined ? { iat: overrides.iat } : {}),
    },
    STATE_SECRET,
  );
}

// ---- E2: missing code → 400 missing_params ------------------------------------

test("E2 missing code → 400 missing_params, completeAuthorization not called", async () => {
  lastCompleteAuthCall = null;
  const stateToken = await makeValidStateToken();
  const req = new Request(
    `https://dovecote.example/oidc/callback?state=${encodeURIComponent(stateToken)}`,
  );
  const res = await authorizeApp.fetch(req, makeEnv(), {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as any);
  expect(res.status).toBe(400);
  expect((await res.json() as any).error).toBe("missing_params");
  expect(lastCompleteAuthCall).toBeNull();
});

// ---- E3: missing state → 400 missing_params -----------------------------------

test("E3 missing state → 400 missing_params, completeAuthorization not called", async () => {
  lastCompleteAuthCall = null;
  const req = new Request(
    `https://dovecote.example/oidc/callback?code=upstream-code`,
  );
  const res = await authorizeApp.fetch(req, makeEnv(), {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as any);
  expect(res.status).toBe(400);
  expect((await res.json() as any).error).toBe("missing_params");
  expect(lastCompleteAuthCall).toBeNull();
});

// ---- E4: no OAUTH_PROVIDER → 500 no_provider ----------------------------------

test("E4 no OAUTH_PROVIDER → 500 no_provider, completeAuthorization not called", async () => {
  lastCompleteAuthCall = null;
  const stateToken = await makeValidStateToken();
  const req = new Request(
    `https://dovecote.example/oidc/callback?code=upstream-code&state=${encodeURIComponent(stateToken)}`,
  );
  const res = await authorizeApp.fetch(
    req,
    makeEnv({ OAUTH_PROVIDER: undefined }),
    { waitUntil: () => {}, passThroughOnException: () => {} } as any,
  );
  expect(res.status).toBe(500);
  expect((await res.json() as any).error).toBe("no_provider");
  expect(lastCompleteAuthCall).toBeNull();
});

// ---- E5a: OIDC_STATE_SECRET missing → 500 config_error ------------------------

test("E5a OIDC_STATE_SECRET missing → 500 config_error, completeAuthorization not called", async () => {
  lastCompleteAuthCall = null;
  const stateToken = await makeValidStateToken();
  const req = new Request(
    `https://dovecote.example/oidc/callback?code=upstream-code&state=${encodeURIComponent(stateToken)}`,
  );
  const res = await authorizeApp.fetch(
    req,
    makeEnv({ OIDC_STATE_SECRET: undefined }),
    { waitUntil: () => {}, passThroughOnException: () => {} } as any,
  );
  expect(res.status).toBe(500);
  expect((await res.json() as any).error).toBe("config_error");
  expect(lastCompleteAuthCall).toBeNull();
});

// ---- E5b: OIDC_STATE_SECRET len<32 → 500 config_error -------------------------

test("E5b OIDC_STATE_SECRET len<32 → 500 config_error, completeAuthorization not called", async () => {
  lastCompleteAuthCall = null;
  const stateToken = await makeValidStateToken();
  const req = new Request(
    `https://dovecote.example/oidc/callback?code=upstream-code&state=${encodeURIComponent(stateToken)}`,
  );
  const res = await authorizeApp.fetch(
    req,
    makeEnv({ OIDC_STATE_SECRET: "short" }),
    { waitUntil: () => {}, passThroughOnException: () => {} } as any,
  );
  expect(res.status).toBe(500);
  expect((await res.json() as any).error).toBe("config_error");
  expect(lastCompleteAuthCall).toBeNull();
});

// ---- E6: garbage state token → 400 invalid_state ------------------------------

test("E6 garbage state token → 400 invalid_state, completeAuthorization not called", async () => {
  lastCompleteAuthCall = null;
  const req = new Request(
    `https://dovecote.example/oidc/callback?code=upstream-code&state=garbage-not-a-valid-token`,
  );
  const res = await authorizeApp.fetch(req, makeEnv(), {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as any);
  expect(res.status).toBe(400);
  expect((await res.json() as any).error).toBe("invalid_state");
  expect(lastCompleteAuthCall).toBeNull();
});

// ---- E7: expired state (iat = now - 700) → 400 state_expired ------------------

test("E7 expired state iat → 400 state_expired, completeAuthorization not called", async () => {
  lastCompleteAuthCall = null;
  const expiredIat = Math.floor(Date.now() / 1000) - 700;
  const stateToken = await makeValidStateToken({ iat: expiredIat });
  const req = new Request(
    `https://dovecote.example/oidc/callback?code=upstream-code&state=${encodeURIComponent(stateToken)}`,
  );
  const res = await authorizeApp.fetch(req, makeEnv(), {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as any);
  expect(res.status).toBe(400);
  expect((await res.json() as any).error).toBe("state_expired");
  expect(lastCompleteAuthCall).toBeNull();
});

// ---- E8: untrusted issuer → 400 untrusted_issuer ------------------------------

test("E8 untrusted issuer in id_token → 400 untrusted_issuer, completeAuthorization not called", async () => {
  lastCompleteAuthCall = null;
  mockConfig = { iss: "https://evil.example.test" };
  const stateToken = await makeValidStateToken();
  const req = new Request(
    `https://dovecote.example/oidc/callback?code=upstream-code&state=${encodeURIComponent(stateToken)}`,
  );
  const res = await authorizeApp.fetch(req, makeEnv(), {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as any);
  expect(res.status).toBe(400);
  expect((await res.json() as any).error).toBe("untrusted_issuer");
  expect(lastCompleteAuthCall).toBeNull();
});

// ---- E9: bad signature (wrong key) → 400 bad_signature ------------------------

test("E9 id_token signed with wrong key → 400 bad_signature, completeAuthorization not called", async () => {
  lastCompleteAuthCall = null;
  const wrongKp = await jose.generateKeyPair("RS256");
  mockConfig = { signingKp: wrongKp };
  const stateToken = await makeValidStateToken();
  const req = new Request(
    `https://dovecote.example/oidc/callback?code=upstream-code&state=${encodeURIComponent(stateToken)}`,
  );
  const res = await authorizeApp.fetch(req, makeEnv(), {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as any);
  expect(res.status).toBe(400);
  expect((await res.json() as any).error).toBe("bad_signature");
  expect(lastCompleteAuthCall).toBeNull();
});

// ---- E10: expired id_token (exp = now - 3600) → 400 expired_token -------------

test("E10 expired id_token → 400 expired_token, completeAuthorization not called", async () => {
  lastCompleteAuthCall = null;
  const expiredExp = Math.floor(Date.now() / 1000) - 3600;
  mockConfig = { exp: expiredExp };
  const stateToken = await makeValidStateToken();
  const req = new Request(
    `https://dovecote.example/oidc/callback?code=upstream-code&state=${encodeURIComponent(stateToken)}`,
  );
  const res = await authorizeApp.fetch(req, makeEnv(), {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as any);
  expect(res.status).toBe(400);
  expect((await res.json() as any).error).toBe("expired_token");
  expect(lastCompleteAuthCall).toBeNull();
});

// ---- E11: nonce mismatch → 400 nonce_mismatch ---------------------------------

test("E11 nonce mismatch → 400 nonce_mismatch, completeAuthorization not called", async () => {
  lastCompleteAuthCall = null;
  // id_token will have the default RP_NONCE but state will have a different nonce
  const stateToken = await makeValidStateToken({ nonce: "different-nonce" });
  const req = new Request(
    `https://dovecote.example/oidc/callback?code=upstream-code&state=${encodeURIComponent(stateToken)}`,
  );
  const res = await authorizeApp.fetch(req, makeEnv(), {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as any);
  expect(res.status).toBe(400);
  expect((await res.json() as any).error).toBe("nonce_mismatch");
  expect(lastCompleteAuthCall).toBeNull();
});

// ---- E12: upstream exchange fails → 502 upstream_exchange_failed ---------------

test("E12 upstream exchange non-200 → 502 upstream_exchange_failed, completeAuthorization not called", async () => {
  lastCompleteAuthCall = null;
  mockConfig = {
    tokenResponse: new Response(JSON.stringify({ error: "server_error" }), {
      status: 500,
    }),
  };
  const stateToken = await makeValidStateToken();
  const req = new Request(
    `https://dovecote.example/oidc/callback?code=upstream-code&state=${encodeURIComponent(stateToken)}`,
  );
  const res = await authorizeApp.fetch(req, makeEnv(), {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as any);
  expect(res.status).toBe(502);
  expect((await res.json() as any).error).toBe("upstream_exchange_failed");
  expect(lastCompleteAuthCall).toBeNull();
});

test("E12b upstream exchange 200 but no id_token → 502 upstream_exchange_failed, completeAuthorization not called", async () => {
  lastCompleteAuthCall = null;
  mockConfig = {
    tokenResponse: new Response(JSON.stringify({ access_token: "at123" }), {
      status: 200,
    }),
  };
  const stateToken = await makeValidStateToken();
  const req = new Request(
    `https://dovecote.example/oidc/callback?code=upstream-code&state=${encodeURIComponent(stateToken)}`,
  );
  const res = await authorizeApp.fetch(req, makeEnv(), {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as any);
  expect(res.status).toBe(502);
  expect((await res.json() as any).error).toBe("upstream_exchange_failed");
  expect(lastCompleteAuthCall).toBeNull();
});

// ---- E13: resolveUserId fails (KV.put throws) → 500 user_resolve_failed -------

test("E13 KV.put throws → 500 user_resolve_failed, completeAuthorization not called", async () => {
  lastCompleteAuthCall = null;
  const kv = new MockKV();
  // Override put to throw
  (kv as any).put = async () => {
    throw new Error("KV write failure");
  };
  const stateToken = await makeValidStateToken();
  const req = new Request(
    `https://dovecote.example/oidc/callback?code=upstream-code&state=${encodeURIComponent(stateToken)}`,
  );
  const env = makeEnv({ OAUTH_KV: kv as any });
  const res = await authorizeApp.fetch(req, env, {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as any);
  expect(res.status).toBe(500);
  expect((await res.json() as any).error).toBe("user_resolve_failed");
  expect(lastCompleteAuthCall).toBeNull();
});

// ---- Ebad_aud: bad audience, correct key → 400 bad_signature (current mapping) --

test("Ebad_aud bad aud + correct key → 400 bad_signature (current mapping), completeAuthorization not called", async () => {
  lastCompleteAuthCall = null;
  // Use the real iss but wrong audience — oidc-verify maps bad_audience → default → bad_signature
  mockConfig = { aud: "wrong-audience" };
  const stateToken = await makeValidStateToken();
  const req = new Request(
    `https://dovecote.example/oidc/callback?code=upstream-code&state=${encodeURIComponent(stateToken)}`,
  );
  const res = await authorizeApp.fetch(req, makeEnv(), {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as any);
  expect(res.status).toBe(400);
  expect((await res.json() as any).error).toBe("bad_signature");
  expect(lastCompleteAuthCall).toBeNull();
});

// ---- Eiat_missing: correctly-signed state token without iat -------------------

// Helper: replicated signing (must NOT import src codec, to test independently)
function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSha256Local(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return base64urlEncode(new Uint8Array(sig));
}

async function signStatePayloadNoIat(
  body: Record<string, unknown>,
  secret: string,
): Promise<string> {
  const bodyJson = JSON.stringify(body);
  const bodyEnc = base64urlEncode(new TextEncoder().encode(bodyJson));
  const sig = await hmacSha256Local(secret, bodyEnc);
  return `${bodyEnc}.${sig}`;
}

test("Eiat_missing (1) correctly-HMAC-signed token without iat → decodeOidcState returns null", async () => {
  const noIatToken = await signStatePayloadNoIat(
    {
      clientId: "cid",
      redirectUri: CLIENT_REDIRECT_URI,
      scope: ["dovecote:notify"],
      state: CLIENT_STATE,
      nonce: RP_NONCE,
      responseType: "code",
      // no iat field
    },
    STATE_SECRET,
  );
  const result = await decodeOidcState(noIatToken, STATE_SECRET);
  expect(result).toBeNull();
});

test("Eiat_missing (2) no-iat state → wired handler → 400 invalid_state, completeAuthorization not called", async () => {
  lastCompleteAuthCall = null;
  const noIatToken = await signStatePayloadNoIat(
    {
      clientId: "cid",
      redirectUri: CLIENT_REDIRECT_URI,
      scope: ["dovecote:notify"],
      state: CLIENT_STATE,
      nonce: RP_NONCE,
      responseType: "code",
      // no iat field
    },
    STATE_SECRET,
  );
  const req = new Request(
    `https://dovecote.example/oidc/callback?code=upstream-code&state=${encodeURIComponent(noIatToken)}`,
  );
  const res = await authorizeApp.fetch(req, makeEnv(), {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as any);
  expect(res.status).toBe(400);
  expect((await res.json() as any).error).toBe("invalid_state");
  expect(lastCompleteAuthCall).toBeNull();
});

// ---- E14: happy path → 302 (strengthened with codeChallenge / clientId checks) --

test("E14 happy path: valid state+code → 302 with code=dvc_ and state=clientstate", async () => {
  lastCompleteAuthCall = null;
  lastExchangeBody = null;
  const env = makeEnv();
  const stateToken = await makeValidStateToken();

  const req = new Request(
    `https://dovecote.example/oidc/callback?code=upstream-code&state=${encodeURIComponent(stateToken)}`,
  );

  const res = await authorizeApp.fetch(req, env, {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as any);

  expect(res.status).toBe(302);
  const loc = res.headers.get("Location") ?? "";
  expect(loc).toContain("code=dvc_");
  expect(loc).toContain(`state=${CLIENT_STATE}`);

  // completeAuthorization was called with the correct request fields
  expect(lastCompleteAuthCall).not.toBeNull();
  const request = (lastCompleteAuthCall as any).request;
  expect(request.codeChallenge).toBe("ch");
  expect(request.clientId).toBe("cid");
  expect(request.codeChallengeMethod).toBe("S256");

  // EX-A/EX-B: token exchange POST redirect_uri must be DOVECOTE_CALLBACK, not client redirect.
  expect(lastExchangeBody).not.toBeNull();
  expect(new URLSearchParams(lastExchangeBody!).get("redirect_uri")).toBe(DOVECOTE_CALLBACK);
});
