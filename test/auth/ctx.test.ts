import { test, expect } from "bun:test";
import { extractAuth, ANONYMOUS } from "../../src/auth/ctx";

test("extractAuth with valid userId and scopes", () => {
  const ctx = {
    props: { userId: "op", scopes: ["dovecote:notify"] },
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as any;

  const result = extractAuth(ctx);
  expect(result).toEqual({
    userId: "op",
    scopes: ["dovecote:notify"],
    authMethod: "oauth",
    ip: "unknown",
  });
});

test("extractAuth with empty props", () => {
  const ctx = {
    props: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as any;

  const result = extractAuth(ctx);
  expect(result).toEqual(ANONYMOUS);
});

test("extractAuth with null props", () => {
  const ctx = {
    props: null,
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as any;

  const result = extractAuth(ctx);
  expect(result).toEqual(ANONYMOUS);
});

test("extractAuth with missing props", () => {
  const ctx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as any;

  const result = extractAuth(ctx);
  expect(result).toEqual(ANONYMOUS);
});

test("extractAuth with malformed userId (number instead of string)", () => {
  const ctx = {
    props: { userId: 123, scopes: "bad" },
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as any;

  const result = extractAuth(ctx);
  expect(result).toEqual(ANONYMOUS);
});

// C-AuthMethod-OidcWidening: enum admits "oidc" so OIDC-issued contexts
// don't get silently coerced to the default "oauth".
test("extractAuth admits authMethod=\"oidc\" without coercion", () => {
  const ctx = {
    props: {
      userId: "u",
      scopes: [],
      authMethod: "oidc",
      ip: "1.2.3.4",
    },
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as any;

  const result = extractAuth(ctx);
  expect(result).toEqual({
    userId: "u",
    scopes: [],
    authMethod: "oidc",
    ip: "1.2.3.4",
  });
});
