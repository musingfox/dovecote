import { test, expect } from "bun:test";
import { tokenMetadataSchema } from "../../src/contracts/tokens.js";

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
