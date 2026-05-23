import { test, expect, mock, beforeEach, beforeAll } from "bun:test";
import { Hono } from "hono";
import * as jose from "jose";
import { createAuthExchangeOidcApp } from "../../src/auth-exchange-oidc.js";
import {
  KVWriteError,
  MissingPepperError,
} from "../../src/auth/api-token.js";
import type { Env } from "../../src/types.js";
import type {
  OidcVerifyOutcome,
  VerifyOidcIdTokenInput,
} from "../../src/auth/oidc-verify.js";
import { MockKV } from "../helpers/mock-kv.js";

const ISSUER = "https://issuer.example";
const AUDIENCE = "aud-1";
const SUB = "alice";

let trustedKeyPair: jose.GenerateKeyPairResult;
let validIdToken: string;

beforeAll(async () => {
  trustedKeyPair = await jose.generateKeyPair("RS256", { extractable: true });
  const now = Math.floor(Date.now() / 1000);
  validIdToken = await new jose.SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(SUB)
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 3600)
    .sign(trustedKeyPair.privateKey);
});

interface ServiceOverrides {
  issueToken?: (...args: any[]) => any;
  checkRateLimit?: (...args: any[]) => any;
  verifyOidcIdToken?: (input: VerifyOidcIdTokenInput) => Promise<OidcVerifyOutcome>;
  resolveUserId?: (...args: any[]) => any;
  parseOidcIssuers?: (...args: any[]) => any;
}

function makeServices(overrides: ServiceOverrides = {}) {
  return {
    issueToken: mock(
      overrides.issueToken ??
        (async (_params: any, _env: any) => ({
          token: "dvct_" + "a".repeat(32),
          tokenId: "tid_new",
          expiresAt: Date.now() + 7_776_000 * 1000,
        })),
    ),
    checkRateLimit: mock(
      overrides.checkRateLimit ??
        (async () => ({ allowed: true, current: 1 })),
    ),
    verifyOidcIdToken: mock(
      overrides.verifyOidcIdToken ??
        (async () =>
          ({
            kind: "ok",
            issuer: ISSUER,
            subClaim: SUB,
            claims: { sub: SUB },
          }) as OidcVerifyOutcome),
    ),
    resolveUserId: mock(
      overrides.resolveUserId ??
        (async () => ({ userId: SUB, scopes: ["dovecote:notify"] })),
    ),
    parseOidcIssuers: mock(
      overrides.parseOidcIssuers ??
        (() => [
          { issuer: ISSUER, jwks_uri: `${ISSUER}/jwks`, audience: AUDIENCE },
        ]),
    ),
  };
}

function buildEnv(opts: { hmacPepper?: string; oidcIssuers?: string } = {}): Env {
  return {
    OAUTH_KV: new MockKV() as any,
    OAUTH_PASSWORD: "test",
    COOKIE_ENCRYPTION_KEY: "x".repeat(32),
    HMAC_PEPPER: opts.hmacPepper ?? "pepper",
    OIDC_ISSUERS: opts.oidcIssuers,
  };
}

function createExecCtx() {
  return {
    props: null,
    waitUntil: (_p: Promise<any>) => {},
    passThroughOnException: () => {},
  } as any;
}

function buildApp(services = makeServices()) {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/", createAuthExchangeOidcApp(services as any));
  return { app, services };
}

beforeEach(() => {
  mock.restore();
});

function req(body: unknown, opts: { headers?: Record<string, string> } = {}) {
  return new Request("http://localhost/v1/auth/exchange-oidc", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.headers ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// --- Happy path -----------------------------------------------------------

test("C-Endpoint-ExchangeOidc: 201 with valid id_token mints dvct_*", async () => {
  const { app, services } = buildApp();
  const env = buildEnv();
  const res = await app.fetch(req({ id_token: validIdToken }), env, createExecCtx());
  expect(res.status).toBe(201);
  const body = (await res.json()) as any;
  expect(body.token).toMatch(/^dvct_/);
  expect(body.userId).toBe(SUB);
  expect(body.scopes).toEqual(["dovecote:notify"]);
  expect(typeof body.expiresAt).toBe("number");

  expect(services.issueToken).toHaveBeenCalledTimes(1);
  const call = (services.issueToken as any).mock.calls[0];
  expect(call[0].userId).toBe(SUB);
  expect(call[0].scopes).toEqual(["dovecote:notify"]);
  expect(call[0].ttlSeconds).toBeUndefined();
});

test("C-Endpoint-ExchangeOidc: 201 with expiresIn + label sets ttl + label", async () => {
  const { app, services } = buildApp();
  const env = buildEnv();
  const res = await app.fetch(
    req({ id_token: validIdToken, expiresIn: "7d", label: "laptop" }),
    env,
    createExecCtx(),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as any;
  expect(body.label).toBe("laptop");
  const call = (services.issueToken as any).mock.calls[0];
  expect(call[0].ttlSeconds).toBe(604_800);
  expect(call[0].label).toBe("laptop");
});

// --- Body validation ------------------------------------------------------

test("C-Endpoint-ExchangeOidc: 400 invalid_request when id_token is missing", async () => {
  const { app, services } = buildApp();
  const env = buildEnv();
  const res = await app.fetch(req({}), env, createExecCtx());
  expect(res.status).toBe(400);
  const body = (await res.json()) as any;
  expect(body.error).toBe("invalid_request");
  expect(body.error_description).toContain("id_token");
  // verifyOidcIdToken never called
  expect(services.verifyOidcIdToken).toHaveBeenCalledTimes(0);
});

test("C-Endpoint-ExchangeOidc: 400 on malformed JSON body", async () => {
  const { app } = buildApp();
  const env = buildEnv();
  const r = new Request("http://localhost/v1/auth/exchange-oidc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  const res = await app.fetch(r, env, createExecCtx());
  expect(res.status).toBe(400);
});

// --- Verify-outcome → 401 mapping ----------------------------------------

const verifyCases: Array<[OidcVerifyOutcome["kind"], string]> = [
  ["untrusted_issuer", "untrusted_issuer"],
  ["bad_signature", "bad_signature"],
  ["bad_audience", "bad_audience"],
  ["expired_token", "expired_token"],
  ["iat_skew", "iat_skew"],
  ["malformed_token", "malformed_token"],
];
for (const [kind, expectedDesc] of verifyCases) {
  test(`C-Endpoint-ExchangeOidc: 401 ${kind} maps to error_description=${expectedDesc}`, async () => {
    const { app } = buildApp(
      makeServices({
        verifyOidcIdToken: async () => ({ kind } as OidcVerifyOutcome),
      }),
    );
    const env = buildEnv();
    const res = await app.fetch(
      req({ id_token: validIdToken }),
      env,
      createExecCtx(),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error).toBe("unauthorized");
    expect(body.error_description).toBe(expectedDesc);
  });
}

// --- Untrusted subject (resolveUserId → null) ----------------------------

test("C-Endpoint-ExchangeOidc: 401 untrusted_subject when resolveUserId returns null", async () => {
  const { app } = buildApp(
    makeServices({ resolveUserId: async () => null }),
  );
  const env = buildEnv();
  const res = await app.fetch(req({ id_token: validIdToken }), env, createExecCtx());
  expect(res.status).toBe(401);
  const body = (await res.json()) as any;
  expect(body.error_description).toBe("untrusted_subject");
});

// --- Rate limit ----------------------------------------------------------

test("C-Endpoint-ExchangeOidc: 429 + Retry-After:60 when rate limited", async () => {
  const { app, services } = buildApp(
    makeServices({
      checkRateLimit: async () => ({ allowed: false, current: 99 }),
    }),
  );
  const env = buildEnv();
  const res = await app.fetch(req({ id_token: validIdToken }), env, createExecCtx());
  expect(res.status).toBe(429);
  expect(res.headers.get("Retry-After")).toBe("60");
  // Rate-limit namespace must be "oidc"
  const call = (services.checkRateLimit as any).mock.calls[0];
  expect(call[2]).toBe("oidc");
  // Rate-limit gate runs BEFORE resolveUserId so KV `user:<id>` auto-provision
  // writes cannot be amplified by a flood of valid id_tokens.
  expect(services.resolveUserId).toHaveBeenCalledTimes(0);
});

test("C-Endpoint-ExchangeOidc: 429 for brand-new sub does NOT auto-provision (KV-write amplification closed)", async () => {
  // Valid id_token for a brand-new `sub`, but rate-limit gate denies.
  // Expectation: resolveUserId must NOT be called — proves the auto-provision
  // KV write is gated by the rate-limit, closing the amplification vector.
  const { app, services } = buildApp(
    makeServices({
      verifyOidcIdToken: async () => ({
        kind: "ok",
        issuer: ISSUER,
        subClaim: "novel_sub_xyz",
        claims: { sub: "novel_sub_xyz" },
      }),
      checkRateLimit: async () => ({ allowed: false, current: 999, retryAfter: 60 }),
      // If invoked, this would auto-provision a fresh user — that's the bug.
      resolveUserId: async () => ({
        userId: "novel_sub_xyz",
        scopes: ["dovecote:notify"],
      }),
    }),
  );
  const env = buildEnv();
  const res = await app.fetch(req({ id_token: validIdToken }), env, createExecCtx());
  expect(res.status).toBe(429);
  expect(res.headers.get("Retry-After")).toBe("60");
  const body = (await res.json()) as any;
  expect(body.error).toBe("rate_limited");
  // Hard invariant: resolveUserId must not have been called.
  expect((services.resolveUserId as any).mock.calls.length).toBe(0);
  // Verify still ran (cheap rejection path requires verify-first).
  expect(services.verifyOidcIdToken).toHaveBeenCalledTimes(1);
  // Token must not have been issued.
  expect(services.issueToken).toHaveBeenCalledTimes(0);
});

// --- 503 misconfigured ---------------------------------------------------

test("C-Endpoint-ExchangeOidc: 503 misconfigured when HMAC_PEPPER missing (MissingPepperError)", async () => {
  const { app } = buildApp(
    makeServices({
      issueToken: async () => {
        throw new MissingPepperError();
      },
    }),
  );
  const env = buildEnv({ hmacPepper: "" });
  const res = await app.fetch(req({ id_token: validIdToken }), env, createExecCtx());
  expect(res.status).toBe(503);
  const body = (await res.json()) as any;
  expect(body.error).toBe("misconfigured");
});

test("C-Endpoint-ExchangeOidc: 503 misconfigured when OIDC_ISSUERS unset", async () => {
  // Note: we use the REAL parseOidcIssuers here (not a mock), and env.OIDC_ISSUERS is unset.
  const services = makeServices();
  // Override mock with actual implementation
  delete (services as any).parseOidcIssuers;
  const app = new Hono<{ Bindings: Env }>();
  app.route(
    "/",
    createAuthExchangeOidcApp({
      issueToken: services.issueToken as any,
      checkRateLimit: services.checkRateLimit as any,
      verifyOidcIdToken: services.verifyOidcIdToken as any,
      resolveUserId: services.resolveUserId as any,
    }),
  );
  const env = buildEnv(); // OIDC_ISSUERS unset
  const res = await app.fetch(req({ id_token: validIdToken }), env, createExecCtx());
  expect(res.status).toBe(503);
  const body = (await res.json()) as any;
  expect(body.error).toBe("misconfigured");
});

// --- 500 on resolveUserId KV write failure -------------------------------

test("C-Endpoint-ExchangeOidc: 500 internal_error when resolveUserId throws KVWriteError", async () => {
  const { app } = buildApp(
    makeServices({
      resolveUserId: async () => {
        throw new KVWriteError("simulated KV failure");
      },
    }),
  );
  const env = buildEnv();
  const res = await app.fetch(req({ id_token: validIdToken }), env, createExecCtx());
  expect(res.status).toBe(500);
  const body = (await res.json()) as any;
  expect(body.error).toBe("internal_error");
});

// --- Brand new sub auto-provisions ---------------------------------------

test("C-Endpoint-ExchangeOidc: brand-new sub → 201 with default scopes from resolveUserId", async () => {
  const { app } = buildApp(
    makeServices({
      verifyOidcIdToken: async () => ({
        kind: "ok",
        issuer: ISSUER,
        subClaim: "fresh_user",
        claims: { sub: "fresh_user" },
      }),
      resolveUserId: async () => ({
        userId: "fresh_user",
        scopes: ["dovecote:notify"],
      }),
    }),
  );
  const env = buildEnv();
  const res = await app.fetch(req({ id_token: validIdToken }), env, createExecCtx());
  expect(res.status).toBe(201);
  const body = (await res.json()) as any;
  expect(body.userId).toBe("fresh_user");
  expect(body.scopes).toEqual(["dovecote:notify"]);
});
