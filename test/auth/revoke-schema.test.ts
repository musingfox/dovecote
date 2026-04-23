import { test, expect } from "bun:test";
import { validateRevokeBody } from "../../src/auth/revoke-schema.js";

test("revoke schema: valid 20-char lowercase grantId", () => {
  const result = validateRevokeBody({ grantId: "abcdefghijklmnopqrst" });

  expect(result.success).toBe(true);
  expect(result.data).toEqual({ grantId: "abcdefghijklmnopqrst" });
  expect(result.error).toBeUndefined();
});

test("revoke schema: valid 21-char grantId with hyphens", () => {
  const result = validateRevokeBody({ grantId: "a-b-c-d-e-f-g-h-i-j-k" });

  expect(result.success).toBe(true);
  expect(result.data).toEqual({ grantId: "a-b-c-d-e-f-g-h-i-j-k" });
  expect(result.error).toBeUndefined();
});

test("revoke schema: too short grantId fails", () => {
  const result = validateRevokeBody({ grantId: "short" });

  expect(result.success).toBe(false);
  expect(result.error).toBeTruthy();
  expect(result.data).toBeUndefined();
});

test("revoke schema: uppercase grantId fails", () => {
  const result = validateRevokeBody({ grantId: "ABCDEFGHIJKLMNOPQRST" });

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
