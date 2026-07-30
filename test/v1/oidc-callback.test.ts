import { test, expect } from "bun:test";

// OIDC RP callback tests removed (CfAccessOidcRemoved + DeviceFlowRemoved cleanup).
// File kept per restore; no failing assertions.

test("oidc-callback removed: placeholder passes", () => {
  expect(true).toBe(true);
});
