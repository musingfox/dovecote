import { test, expect } from "bun:test";
import { validateRevokeBody } from "../../src/auth/revoke-schema.js";

test("revoke schema: valid 20-char alphanumeric grantId", () => {
  const result = validateRevokeBody({ grantId: "abcdefghijklmnopqrst" });

  expect(result.success).toBe(true);
  expect(result.data).toEqual({ grantId: "abcdefghijklmnopqrst" });
  expect(result.error).toBeUndefined();
});

test("revoke schema: valid mixed-case grantId with underscore", () => {
  const result = validateRevokeBody({ grantId: "5BJ6fIn2hfVOEiX8_test" });

  expect(result.success).toBe(true);
  expect(result.data).toEqual({ grantId: "5BJ6fIn2hfVOEiX8_test" });
  expect(result.error).toBeUndefined();
});

test("revoke schema: too short grantId fails", () => {
  const result = validateRevokeBody({ grantId: "short" });

  expect(result.success).toBe(false);
  expect(result.error).toBeTruthy();
  expect(result.data).toBeUndefined();
});

test("revoke schema: grantId with space fails", () => {
  const result = validateRevokeBody({ grantId: "abc def ghi jkl mnop" });

  expect(result.success).toBe(false);
  expect(result.error).toBeTruthy();
  expect(result.data).toBeUndefined();
});

test("revoke schema: special character in grantId fails", () => {
  const result = validateRevokeBody({ grantId: "abcdefghijklmnopqrs!" });

  expect(result.success).toBe(false);
  expect(result.error).toBeTruthy();
  expect(result.data).toBeUndefined();
});

test("revoke schema: missing grantId field fails", () => {
  const result = validateRevokeBody({});

  expect(result.success).toBe(false);
  expect(result.error).toBeTruthy();
  expect(result.data).toBeUndefined();
});

test("revoke schema: wrong field name (grant_id) fails", () => {
  const result = validateRevokeBody({ grant_id: "abcdefghijklmnopqrst" });

  expect(result.success).toBe(false);
  expect(result.error).toBeTruthy();
  expect(result.data).toBeUndefined();
});

test("revoke schema: null body fails", () => {
  const result = validateRevokeBody(null);

  expect(result.success).toBe(false);
  expect(result.error).toBeTruthy();
  expect(result.data).toBeUndefined();
});
