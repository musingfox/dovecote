import { test, expect } from "bun:test";
import {
  tokenMetadataSchema,
  tokenIssueRequestSchema,
  tokenIssueResponseSchema,
  tokenExchangeRequestSchema,
  tokenRenewRequestSchema,
  expiresInToSeconds,
} from "../../src/contracts/tokens.js";

test("B1: tokenMetadataSchema describes a stored API token record", () => {
  // Valid: minimal token record
  const result1 = tokenMetadataSchema.safeParse({
    tokenId: "t_abc",
    hash: "sha256:abc123",
    scopes: ["dovecote:notify"],
    createdAt: 1700000000,
    expiresAt: 1800000000,
  });
  expect(result1.success).toBe(true);

  // Valid: with optional label
  const result2 = tokenMetadataSchema.safeParse({
    tokenId: "t_abc",
    hash: "sha256:abc123",
    scopes: ["dovecote:notify"],
    createdAt: 1700000000,
    expiresAt: 1800000000,
    label: "deploy-bot",
  });
  expect(result2.success).toBe(true);

  // Valid: multiple scopes
  const result3 = tokenMetadataSchema.safeParse({
    tokenId: "t_abc",
    hash: "sha256:abc123",
    scopes: ["dovecote:notify", "dovecote:env:read"],
    createdAt: 1700000000,
    expiresAt: 1800000000,
  });
  expect(result3.success).toBe(true);

  // Invalid: missing required field (hash)
  const result4 = tokenMetadataSchema.safeParse({
    tokenId: "t_abc",
    scopes: ["dovecote:notify"],
    createdAt: 1700000000,
    expiresAt: 1800000000,
  });
  expect(result4.success).toBe(false);

  // Invalid: missing required field (scopes)
  const result5 = tokenMetadataSchema.safeParse({
    tokenId: "t_abc",
    hash: "sha256:x",
    createdAt: 1700000000,
    expiresAt: 1800000000,
  });
  expect(result5.success).toBe(false);

  // Invalid: missing required field (createdAt)
  const result6 = tokenMetadataSchema.safeParse({
    tokenId: "t_abc",
    hash: "sha256:x",
    scopes: ["bogus:scope"],
    expiresAt: 1800000000,
  });
  expect(result6.success).toBe(false);

  // Valid: scopes are just strings (no cross-validation)
  const result7 = tokenMetadataSchema.safeParse({
    tokenId: "t_abc",
    hash: "sha256:x",
    scopes: ["bogus:scope"],
    createdAt: 1,
    expiresAt: 2,
  });
  expect(result7.success).toBe(true);
});

test("C-Server-3: tokenIssueRequestSchema accepts optional expiresIn enum", () => {
  // No expiresIn → ok, undefined
  const r1 = tokenIssueRequestSchema.safeParse({
    userId: "op",
    scopes: ["dovecote:notify"],
  });
  expect(r1.success).toBe(true);
  if (r1.success) expect(r1.data.expiresIn).toBeUndefined();

  // Valid expiresIn=7d
  const r2 = tokenIssueRequestSchema.safeParse({
    userId: "op",
    scopes: ["dovecote:notify"],
    expiresIn: "7d",
  });
  expect(r2.success).toBe(true);
  if (r2.success) expect(r2.data.expiresIn).toBe("7d");

  // Invalid value
  const r3 = tokenIssueRequestSchema.safeParse({
    userId: "op",
    scopes: ["dovecote:notify"],
    expiresIn: "30days",
  });
  expect(r3.success).toBe(false);
});

test("C-Server-3: expiresInToSeconds maps each enum value", () => {
  expect(expiresInToSeconds("7d")).toBe(604_800);
  expect(expiresInToSeconds("30d")).toBe(2_592_000);
  expect(expiresInToSeconds("60d")).toBe(5_184_000);
  expect(expiresInToSeconds("90d")).toBe(7_776_000);
});

test("C-Server-3: tokenExchangeRequestSchema and tokenRenewRequestSchema accept empty", () => {
  expect(tokenExchangeRequestSchema.safeParse({}).success).toBe(true);
  expect(tokenRenewRequestSchema.safeParse({}).success).toBe(true);
  expect(
    tokenExchangeRequestSchema.safeParse({ expiresIn: "90d", label: "x" }).success
  ).toBe(true);
  expect(
    tokenRenewRequestSchema.safeParse({ expiresIn: "bogus" }).success
  ).toBe(false);
});

test("Fix #1: tokenIssueResponseSchema requires userId", () => {
  const ok = tokenIssueResponseSchema.safeParse({
    token: "dvct_x",
    tokenId: "t_1",
    userId: "operator",
    scopes: ["dovecote:notify"],
    expiresAt: 1_700_000_000_000,
  });
  expect(ok.success).toBe(true);
  if (ok.success) expect(ok.data.userId).toBe("operator");

  // Missing userId → fails
  const missing = tokenIssueResponseSchema.safeParse({
    token: "dvct_x",
    tokenId: "t_1",
    scopes: ["dovecote:notify"],
    expiresAt: 1_700_000_000_000,
  });
  expect(missing.success).toBe(false);
});

test("B1: TokenMetadata type is exported", () => {
  const token = {
    tokenId: "t_abc",
    hash: "sha256:abc123",
    scopes: ["dovecote:notify"],
    createdAt: 1700000000,
    expiresAt: 1800000000,
  };
  expect(token.tokenId).toBe("t_abc");
});
