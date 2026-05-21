import { test, expect } from "bun:test";
import { extractAuth, ANONYMOUS } from "../../src/auth/ctx";

test("extractAuth with legacy props (no authMethod/ip) fills in defaults", () => {
  const ctx = {
    props: { userId: "operator", scopes: ["dovecote:notify"] },
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as any;

  const result = extractAuth(ctx);
  expect(result).toEqual({
    userId: "operator",
    scopes: ["dovecote:notify"],
    authMethod: "oauth",
    ip: "unknown",
  });
});

test("extractAuth with legacy props including tokenId", () => {
  const ctx = {
    props: {
      userId: "operator",
      scopes: ["dovecote:notify"],
      tokenId: "t_xyz",
    },
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as any;

  const result = extractAuth(ctx);
  expect(result).toEqual({
    userId: "operator",
    scopes: ["dovecote:notify"],
    authMethod: "oauth",
    ip: "unknown",
    tokenId: "t_xyz",
  });
});

test("extractAuth with empty props returns ANONYMOUS", () => {
  const ctx = {
    props: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as any;

  const result = extractAuth(ctx);
  expect(result).toEqual(ANONYMOUS);
});

test("extractAuth with null props returns ANONYMOUS", () => {
  const ctx = {
    props: null,
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as any;

  const result = extractAuth(ctx);
  expect(result).toEqual(ANONYMOUS);
});

test("extractAuth with missing props returns ANONYMOUS", () => {
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
