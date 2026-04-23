import { test, expect } from "bun:test";
import { extractAuth, ANONYMOUS } from "../../src/auth/ctx";

test("extractAuth with valid userId and scopes", () => {
  const ctx = {
    props: { userId: "op", scopes: ["dovecote:notify"] },
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as any;

  const result = extractAuth(ctx);
  expect(result).toEqual({ userId: "op", scopes: ["dovecote:notify"] });
});

test("extractAuth with legacy flag (C4 - no strict mode)", () => {
  const ctx = {
    props: {
      legacy: true,
      userId: "legacy-bearer",
      scopes: ["dovecote:notify"],
    },
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as any;

  const result = extractAuth(ctx);
  expect(result).toEqual({
    userId: "legacy-bearer",
    scopes: ["dovecote:notify"],
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
