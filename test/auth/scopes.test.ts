import { test, expect } from "bun:test";
import { SCOPES_SUPPORTED } from "../../src/auth/scopes";

test("SCOPES_SUPPORTED deep equal check", () => {
  expect(SCOPES_SUPPORTED).toEqual(["dovecote:notify", "dovecote:admin"]);
});

test("SCOPES_SUPPORTED contains dovecote:notify", () => {
  expect(SCOPES_SUPPORTED).toContain("dovecote:notify");
});
