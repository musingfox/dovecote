import { test, expect } from "bun:test";
import {
  getOidcClockToleranceSec,
  oidcIssuerConfigSchema,
} from "../../src/auth/oidc-config.js";
import type { Env } from "../../src/types.js";

function envWith(overrides: Partial<Env> = {}): Env {
  return {
    OAUTH_KV: {} as any,
    HMAC_PEPPER: "pep",
    ...overrides,
  } as Env;
}

// ── oidcIssuerConfigSchema (L2 GitHub OIDC dependency) ───────────────────────

test("oidcIssuerConfigSchema: accepts a minimal issuer config", () => {
  const parsed = oidcIssuerConfigSchema.safeParse({
    issuer: "https://issuer.example",
    jwks_uri: "https://issuer.example/jwks",
    audience: "aud-1",
  });
  expect(parsed.success).toBe(true);
});

test("oidcIssuerConfigSchema: accepts optional subClaim", () => {
  const parsed = oidcIssuerConfigSchema.safeParse({
    issuer: "https://issuer.example",
    jwks_uri: "https://issuer.example/jwks",
    audience: "aud-1",
    subClaim: "email",
  });
  expect(parsed.success).toBe(true);
});

test("oidcIssuerConfigSchema: rejects missing audience", () => {
  const parsed = oidcIssuerConfigSchema.safeParse({
    issuer: "https://issuer.example",
    jwks_uri: "https://issuer.example/jwks",
  });
  expect(parsed.success).toBe(false);
});

test("oidcIssuerConfigSchema: rejects non-URL issuer", () => {
  const parsed = oidcIssuerConfigSchema.safeParse({
    issuer: "not-a-url",
    jwks_uri: "https://issuer.example/jwks",
    audience: "aud-1",
  });
  expect(parsed.success).toBe(false);
});

// ── getOidcClockToleranceSec ─────────────────────────────────────────────────

test("getOidcClockToleranceSec: default 60 when unset", () => {
  expect(getOidcClockToleranceSec(envWith())).toBe(60);
});

test("getOidcClockToleranceSec: parses decimal seconds", () => {
  expect(
    getOidcClockToleranceSec(envWith({ OIDC_CLOCK_TOLERANCE_SEC: "120" })),
  ).toBe(120);
});

test("getOidcClockToleranceSec: floors fractional values", () => {
  expect(
    getOidcClockToleranceSec(envWith({ OIDC_CLOCK_TOLERANCE_SEC: "90.9" })),
  ).toBe(90);
});

test("getOidcClockToleranceSec: negative falls back to 60", () => {
  expect(
    getOidcClockToleranceSec(envWith({ OIDC_CLOCK_TOLERANCE_SEC: "-5" })),
  ).toBe(60);
});

test("getOidcClockToleranceSec: non-numeric falls back to 60", () => {
  expect(
    getOidcClockToleranceSec(envWith({ OIDC_CLOCK_TOLERANCE_SEC: "abc" })),
  ).toBe(60);
});
