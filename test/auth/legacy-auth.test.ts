import { test, expect } from "bun:test";
import { legacyAuthenticate } from "../../src/auth/legacy-auth.js";
import { SCOPES_SUPPORTED } from "../../src/auth/scopes.js";
import type { Env } from "../../src/types.js";

function makeEnv(overrides: Partial<Env>): Env {
  return {
    OAUTH_KV: {} as any,
    OAUTH_PASSWORD: "",
    COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length",
    HMAC_PEPPER: "pep",
    ...overrides,
  } as Env;
}

test("legacyAuthenticate: operator + correct password → all scopes", () => {
  const env = makeEnv({ OAUTH_PASSWORD: "legacy" });
  const got = legacyAuthenticate(
    { submittedUsername: "operator", submittedPassword: "legacy" },
    env,
  );
  expect(got).toEqual({
    userId: "operator",
    scopes: [...SCOPES_SUPPORTED],
  });
});

test("legacyAuthenticate: configurable LEGACY_OPERATOR_USERNAME", () => {
  const env = makeEnv({
    OAUTH_PASSWORD: "legacy",
    LEGACY_OPERATOR_USERNAME: "admin",
  });
  const got = legacyAuthenticate(
    { submittedUsername: "admin", submittedPassword: "legacy" },
    env,
  );
  expect(got).toEqual({
    userId: "admin",
    scopes: [...SCOPES_SUPPORTED],
  });
});

test("legacyAuthenticate: wrong password → null", () => {
  const env = makeEnv({ OAUTH_PASSWORD: "legacy" });
  const got = legacyAuthenticate(
    { submittedUsername: "operator", submittedPassword: "wrong" },
    env,
  );
  expect(got).toBeNull();
});

test("legacyAuthenticate: wrong username → null", () => {
  const env = makeEnv({ OAUTH_PASSWORD: "legacy" });
  const got = legacyAuthenticate(
    { submittedUsername: "alice", submittedPassword: "legacy" },
    env,
  );
  expect(got).toBeNull();
});

test("legacyAuthenticate: OAUTH_PASSWORD unset → null", () => {
  const env = makeEnv({ OAUTH_PASSWORD: "" });
  const got = legacyAuthenticate(
    { submittedUsername: "operator", submittedPassword: "anything" },
    env,
  );
  expect(got).toBeNull();
});
