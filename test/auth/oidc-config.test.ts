import { test, expect } from "bun:test";
import {
  parseOidcIssuers,
  getOidcClockToleranceSec,
  OidcConfigError,
} from "../../src/auth/oidc-config.js";
import type { Env } from "../../src/types.js";

function envWith(overrides: Partial<Env> = {}): Env {
  return {
    OAUTH_KV: {} as any,
    OAUTH_PASSWORD: "x",
    COOKIE_ENCRYPTION_KEY: "x".repeat(32),
    HMAC_PEPPER: "pep",
    ...overrides,
  } as Env;
}

test("parseOidcIssuers: unset OIDC_ISSUERS throws OidcConfigError", () => {
  expect(() => parseOidcIssuers(envWith({}))).toThrow(OidcConfigError);
});

test("parseOidcIssuers: empty string throws", () => {
  expect(() => parseOidcIssuers(envWith({ OIDC_ISSUERS: "" }))).toThrow(
    OidcConfigError,
  );
});

test("parseOidcIssuers: malformed JSON throws", () => {
  expect(() =>
    parseOidcIssuers(envWith({ OIDC_ISSUERS: "{not json" })),
  ).toThrow(OidcConfigError);
});

test("parseOidcIssuers: empty array throws (min length 1)", () => {
  expect(() =>
    parseOidcIssuers(envWith({ OIDC_ISSUERS: "[]" })),
  ).toThrow(OidcConfigError);
});

test("parseOidcIssuers: missing required fields throws", () => {
  expect(() =>
    parseOidcIssuers(
      envWith({
        OIDC_ISSUERS: JSON.stringify([{ issuer: "https://a.example" }]),
      }),
    ),
  ).toThrow(OidcConfigError);
});

test("parseOidcIssuers: valid array round-trips", () => {
  const cfg = [
    {
      issuer: "https://issuer.example",
      jwks_uri: "https://issuer.example/.well-known/jwks.json",
      audience: "aud-1",
    },
  ];
  const got = parseOidcIssuers(
    envWith({ OIDC_ISSUERS: JSON.stringify(cfg) }),
  );
  expect(got).toEqual(cfg);
});

test("parseOidcIssuers: allows optional subClaim", () => {
  const cfg = [
    {
      issuer: "https://issuer.example",
      jwks_uri: "https://issuer.example/jwks",
      audience: "aud-1",
      subClaim: "email",
    },
  ];
  const got = parseOidcIssuers(
    envWith({ OIDC_ISSUERS: JSON.stringify(cfg) }),
  );
  expect(got[0]!.subClaim).toBe("email");
});

test("getOidcClockToleranceSec: default 60 when unset", () => {
  expect(getOidcClockToleranceSec(envWith({}))).toBe(60);
});

test("getOidcClockToleranceSec: parses positive integer", () => {
  expect(
    getOidcClockToleranceSec(envWith({ OIDC_CLOCK_TOLERANCE_SEC: "120" })),
  ).toBe(120);
});

test("getOidcClockToleranceSec: negative falls back to default", () => {
  expect(
    getOidcClockToleranceSec(envWith({ OIDC_CLOCK_TOLERANCE_SEC: "-1" })),
  ).toBe(60);
});

test("getOidcClockToleranceSec: non-numeric falls back to default", () => {
  expect(
    getOidcClockToleranceSec(envWith({ OIDC_CLOCK_TOLERANCE_SEC: "abc" })),
  ).toBe(60);
});
