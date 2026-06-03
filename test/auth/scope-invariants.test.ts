import { test, expect } from "bun:test";
import { SCOPES_SUPPORTED } from "../../src/auth/scopes.ts";
import { OIDC_DEFAULT_SCOPES } from "../../src/auth/resolve-user.ts";

test("E6: dovecote:env:read is not a supported scope", () => {
  expect(SCOPES_SUPPORTED).not.toContain("dovecote:env:read");
});

test("E6: OIDC_DEFAULT_SCOPES is a subset of SCOPES_SUPPORTED", () => {
  const supported = new Set<string>(SCOPES_SUPPORTED);
  for (const s of OIDC_DEFAULT_SCOPES) {
    expect(supported.has(s)).toBe(true);
  }
});

test("E6: SCOPES_SUPPORTED === [dovecote:notify, dovecote:admin]", () => {
  expect([...SCOPES_SUPPORTED].sort()).toEqual(["dovecote:admin", "dovecote:notify"]);
});
