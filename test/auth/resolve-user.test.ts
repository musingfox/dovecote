import { test, expect } from "bun:test";

// Form arm of resolveUserId removed (ResolveUserOidcOnly contract).
// Only oidc remains. File kept per restore convention; placeholder passes.
test("resolve-user form removed: placeholder passes", () => {
  expect(true).toBe(true);
});
