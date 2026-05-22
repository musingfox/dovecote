import { test, expect } from "bun:test";
import { validateRevokeBody } from "../../src/auth/revoke-schema.js";

type AnyResult = { success: boolean; data?: { grantId: string; userId: string }; error?: string };
function asAny(r: ReturnType<typeof validateRevokeBody>): AnyResult {
  return r as AnyResult;
}

test("revoke schema: valid 20-char alphanumeric grantId with operator userId", () => {
  const result = validateRevokeBody({ grantId: "abcdefghijklmnopqrst", userId: "operator" });

  expect(result.success).toBe(true);
  expect(asAny(result).data).toEqual({ grantId: "abcdefghijklmnopqrst", userId: "operator" });
  expect(asAny(result).error).toBeUndefined();
});

test("revoke schema: valid mixed-case grantId with underscore and alice userId", () => {
  const result = validateRevokeBody({ grantId: "5BJ6fIn2hfVOEiX8_test", userId: "alice" });

  expect(result.success).toBe(true);
  expect(asAny(result).data).toEqual({ grantId: "5BJ6fIn2hfVOEiX8_test", userId: "alice" });
  expect(asAny(result).error).toBeUndefined();
});

test("revoke schema: too short grantId fails", () => {
  const result = validateRevokeBody({ grantId: "short", userId: "alice" });

  expect(result.success).toBe(false);
  expect(asAny(result).error).toBeTruthy();
  expect(asAny(result).data).toBeUndefined();
});

test("revoke schema: grantId with space fails", () => {
  const result = validateRevokeBody({ grantId: "abc def ghi jkl mnop", userId: "alice" });

  expect(result.success).toBe(false);
  expect(asAny(result).error).toBeTruthy();
  expect(asAny(result).data).toBeUndefined();
});

test("revoke schema: special character in grantId fails", () => {
  const result = validateRevokeBody({ grantId: "abcdefghijklmnopqrs!", userId: "alice" });

  expect(result.success).toBe(false);
  expect(asAny(result).error).toBeTruthy();
  expect(asAny(result).data).toBeUndefined();
});

test("revoke schema: missing grantId field fails", () => {
  const result = validateRevokeBody({ userId: "alice" });

  expect(result.success).toBe(false);
  expect(asAny(result).error).toBeTruthy();
  expect(asAny(result).data).toBeUndefined();
});

test("revoke schema: missing userId field fails", () => {
  const result = validateRevokeBody({ grantId: "abcdefghijklmnopqrst" });

  expect(result.success).toBe(false);
  expect(asAny(result).error).toBeTruthy();
  expect(asAny(result).data).toBeUndefined();
});

test("revoke schema: userId with colon fails (charset)", () => {
  const result = validateRevokeBody({ grantId: "abcdefghijklmnopqrst", userId: "AL:ICE" });

  expect(result.success).toBe(false);
  expect(asAny(result).error).toBeTruthy();
  expect(asAny(result).data).toBeUndefined();
});

test("revoke schema: userId uppercase fails (must be lowercase)", () => {
  const result = validateRevokeBody({ grantId: "abcdefghijklmnopqrst", userId: "ALICE" });

  expect(result.success).toBe(false);
  expect(asAny(result).error).toBeTruthy();
  expect(asAny(result).data).toBeUndefined();
});

test("revoke schema: wrong field name (grant_id) fails", () => {
  const result = validateRevokeBody({ grant_id: "abcdefghijklmnopqrst", userId: "alice" });

  expect(result.success).toBe(false);
  expect(asAny(result).error).toBeTruthy();
  expect(asAny(result).data).toBeUndefined();
});

test("revoke schema: null body fails", () => {
  const result = validateRevokeBody(null);

  expect(result.success).toBe(false);
  expect(asAny(result).error).toBeTruthy();
  expect(asAny(result).data).toBeUndefined();
});
