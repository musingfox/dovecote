/**
 * Committed tests for POST /v1/auth/github-oidc (GitHub Actions OIDC exchange).
 *
 * Mirrors gate-turn-25.test.ts but with adjusted import paths for the
 * test/v1/ directory. Uses real jose verification via jwksResolver injection —
 * verifyOidcIdToken is NOT mocked.
 */

import { test, expect, mock, beforeAll } from "bun:test";
import { Hono } from "hono";
import * as jose from "jose";
import { createAuthGithubOidcApp } from "../../src/auth-github-oidc.js";
import type { GithubOidcServices } from "../../src/auth-github-oidc.js";
import type { Env } from "../../src/types.js";
import { MockKV } from "../helpers/mock-kv.js";

const GH_ISSUER = "https://token.actions.githubusercontent.com";
const EXPECTED_AUD = "https://dovecote.example.com";
const ALLOWED_OWNER = "trusted-org";

let trustedKeyPair: jose.GenerateKeyPairResult;
let attackerKeyPair: jose.GenerateKeyPairResult;

const trustedResolver = ((_issuer: unknown) => async () => trustedKeyPair.publicKey) as any;

beforeAll(async () => {
  trustedKeyPair = await jose.generateKeyPair("RS256", { extractable: true });
  attackerKeyPair = await jose.generateKeyPair("RS256", { extractable: true });
});

async function signGhToken(
  claims: Record<string, unknown>,
  opts: { privateKey?: CryptoKey; exp?: number } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const base = {
    iss: GH_ISSUER,
    aud: EXPECTED_AUD,
    sub: `repo:${ALLOWED_OWNER}/my-repo:ref:refs/heads/main`,
    repository_owner: ALLOWED_OWNER,
    ...claims,
  };
  return new jose.SignJWT(base)
    .setProtectedHeader({ alg: "RS256", kid: "gh-test-kid" })
    .setIssuedAt(now - 30)
    .setExpirationTime(opts.exp ?? now + 300)
    .sign(opts.privateKey ?? trustedKeyPair.privateKey);
}

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    OAUTH_KV: new MockKV() as any,
    OAUTH_PASSWORD: "test",
    COOKIE_ENCRYPTION_KEY: "x".repeat(32),
    HMAC_PEPPER: "test-pepper",
    GITHUB_OIDC_EXPECTED_AUD: EXPECTED_AUD,
    GITHUB_OIDC_ALLOWED_OWNER: ALLOWED_OWNER,
    ...overrides,
  } as Env;
}

function createExecCtx() {
  return {
    props: null,
    waitUntil: (_p: Promise<any>) => {},
    passThroughOnException: () => {},
  } as any;
}

function makeIssueTokenMock() {
  return mock(async (params: { userId: string; scopes: string[]; ttlSeconds?: number }) => {
    const ttl = params.ttlSeconds ?? 900;
    return {
      token: "dvct_" + "x".repeat(32),
      tokenId: "tid_gh_test",
      expiresAt: Date.now() + ttl * 1000,
    };
  });
}

function buildApp(serviceOverrides: Partial<GithubOidcServices> = {}) {
  const issueToken = makeIssueTokenMock();
  const checkRateLimit = mock(async () => ({ allowed: true, current: 1 }));
  const services: GithubOidcServices = {
    issueToken,
    checkRateLimit,
    jwksResolver: trustedResolver,
    ...serviceOverrides,
  };
  const app = new Hono<{ Bindings: Env }>();
  app.route("/", createAuthGithubOidcApp(services));
  return { app, issueToken, checkRateLimit };
}

function req(body: unknown) {
  return new Request("http://localhost/v1/auth/github-oidc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("GH-01: valid GH Actions token → 201, dvct_*, scopes=[dovecote:notify], expiresAt 14-16min", async () => {
  const { app, issueToken } = buildApp();
  const idToken = await signGhToken({ repository_owner: ALLOWED_OWNER });
  const res = await app.fetch(req({ id_token: idToken }), buildEnv(), createExecCtx());
  expect(res.status).toBe(201);
  const body = (await res.json()) as any;
  expect(body.token).toMatch(/^dvct_/);
  expect(body.scopes).toEqual(["dovecote:notify"]);
  expect(typeof body.expiresAt).toBe("number");

  const nowMs = Date.now();
  expect(body.expiresAt).toBeGreaterThanOrEqual(nowMs + 14 * 60 * 1000);
  expect(body.expiresAt).toBeLessThanOrEqual(nowMs + 16 * 60 * 1000);

  expect(issueToken).toHaveBeenCalledTimes(1);
  const call = (issueToken as any).mock.calls[0];
  expect(call[0].scopes).toEqual(["dovecote:notify"]);
  expect(call[0].ttlSeconds).toBeGreaterThanOrEqual(14 * 60);
  expect(call[0].ttlSeconds).toBeLessThanOrEqual(16 * 60);
});

test("GH-02: repository_owner=evil-org → 403 forbidden, issueToken NOT called", async () => {
  const { app, issueToken } = buildApp();
  const idToken = await signGhToken({ repository_owner: "evil-org" });
  const res = await app.fetch(req({ id_token: idToken }), buildEnv(), createExecCtx());
  expect(res.status).toBe(403);
  const body = (await res.json()) as any;
  expect(body.error).toBe("forbidden");
  expect(issueToken).toHaveBeenCalledTimes(0);
});

test("GH-03: attacker keypair, trusted resolver → 401 bad_signature (real jose verify)", async () => {
  const { app, issueToken } = buildApp();
  const idToken = await signGhToken(
    { repository_owner: ALLOWED_OWNER },
    { privateKey: attackerKeyPair.privateKey },
  );
  const res = await app.fetch(req({ id_token: idToken }), buildEnv(), createExecCtx());
  expect(res.status).toBe(401);
  const body = (await res.json()) as any;
  expect(body.error_description).toBe("bad_signature");
  expect(issueToken).toHaveBeenCalledTimes(0);
});

test("GH-04: wrong aud → 401 bad_audience", async () => {
  const { app, issueToken } = buildApp();
  const idToken = await signGhToken({ aud: "wrong-aud", repository_owner: ALLOWED_OWNER });
  const res = await app.fetch(req({ id_token: idToken }), buildEnv(), createExecCtx());
  expect(res.status).toBe(401);
  const body = (await res.json()) as any;
  expect(body.error_description).toBe("bad_audience");
  expect(issueToken).toHaveBeenCalledTimes(0);
});

test("GH-05: expired token (exp=now-120) → 401 expired_token", async () => {
  const { app, issueToken } = buildApp();
  const now = Math.floor(Date.now() / 1000);
  const idToken = await signGhToken(
    { repository_owner: ALLOWED_OWNER },
    { exp: now - 120 },
  );
  const res = await app.fetch(req({ id_token: idToken }), buildEnv(), createExecCtx());
  expect(res.status).toBe(401);
  const body = (await res.json()) as any;
  expect(body.error_description).toBe("expired_token");
  expect(issueToken).toHaveBeenCalledTimes(0);
});

test("GH-06: missing GITHUB_OIDC_EXPECTED_AUD → 503 misconfigured", async () => {
  const { app, issueToken } = buildApp();
  const idToken = await signGhToken({ repository_owner: ALLOWED_OWNER });
  const env = buildEnv({ GITHUB_OIDC_EXPECTED_AUD: undefined });
  const res = await app.fetch(req({ id_token: idToken }), env, createExecCtx());
  expect(res.status).toBe(503);
  const body = (await res.json()) as any;
  expect(body.error).toBe("misconfigured");
  expect(issueToken).toHaveBeenCalledTimes(0);
});

test("GH-07: missing GITHUB_OIDC_ALLOWED_OWNER (aud set) → 503 misconfigured", async () => {
  const { app, issueToken } = buildApp();
  const idToken = await signGhToken({ repository_owner: ALLOWED_OWNER });
  const env = buildEnv({ GITHUB_OIDC_ALLOWED_OWNER: undefined });
  const res = await app.fetch(req({ id_token: idToken }), env, createExecCtx());
  expect(res.status).toBe(503);
  const body = (await res.json()) as any;
  expect(body.error).toBe("misconfigured");
  expect(issueToken).toHaveBeenCalledTimes(0);
});

test("GH-08: expiresIn=90d capped to 900s; expiresAt ≤ now+900+5s", async () => {
  const { app, issueToken } = buildApp();
  const idToken = await signGhToken({ repository_owner: ALLOWED_OWNER });
  const nowMs = Date.now();
  const res = await app.fetch(
    req({ id_token: idToken, expiresIn: "90d" }),
    buildEnv(),
    createExecCtx(),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as any;
  expect(body.expiresAt).toBeLessThanOrEqual(nowMs + 900 * 1000 + 5000);
  const call = (issueToken as any).mock.calls[0];
  expect(call[0].ttlSeconds).toBe(900);
});

test("GH-09: iss=accounts.google.com → 401 untrusted_issuer", async () => {
  const { app, issueToken } = buildApp();
  const now = Math.floor(Date.now() / 1000);
  const idToken = await new jose.SignJWT({
    aud: EXPECTED_AUD,
    repository_owner: ALLOWED_OWNER,
    sub: "subject",
  })
    .setProtectedHeader({ alg: "RS256", kid: "gh-test-kid" })
    .setIssuer("https://accounts.google.com")
    .setIssuedAt(now - 30)
    .setExpirationTime(now + 300)
    .sign(trustedKeyPair.privateKey);
  const res = await app.fetch(req({ id_token: idToken }), buildEnv(), createExecCtx());
  expect(res.status).toBe(401);
  const body = (await res.json()) as any;
  expect(body.error_description).toBe("untrusted_issuer");
  expect(issueToken).toHaveBeenCalledTimes(0);
});
