import { test, expect } from "bun:test";
import {
  hashPassword,
  verifyPassword,
  MissingPepperError,
} from "../../src/auth/password.js";

test("hashPassword returns record with algo/iterations/salt/hash", async () => {
  const record = await hashPassword("hunter2", "pep");
  expect(record.algo).toBe("pbkdf2-sha256");
  expect(record.iterations).toBe(100_000);
  expect(typeof record.salt).toBe("string");
  expect(record.salt.length).toBeGreaterThan(0);
  expect(typeof record.hash).toBe("string");
  expect(record.hash.length).toBeGreaterThan(0);
});

test("hashPassword generates fresh salt on each call", async () => {
  const a = await hashPassword("hunter2", "pep");
  const b = await hashPassword("hunter2", "pep");
  expect(a.salt).not.toBe(b.salt);
  expect(a.hash).not.toBe(b.hash);
});

test("verifyPassword returns true for correct password", async () => {
  const record = await hashPassword("hunter2", "pep");
  expect(await verifyPassword("hunter2", "pep", record)).toBe(true);
});

test("verifyPassword returns false for wrong password", async () => {
  const record = await hashPassword("hunter2", "pep");
  expect(await verifyPassword("wrong", "pep", record)).toBe(false);
});

test("verifyPassword returns false for different pepper", async () => {
  const record = await hashPassword("hunter2", "pep");
  expect(await verifyPassword("hunter2", "different-pep", record)).toBe(false);
});

// C-PasswordRejectsOidcAlgo: any non-PBKDF2 record must return false without
// throwing — the form login handler relies on this to silently refuse
// OIDC-provisioned accounts (`algo:"oidc"` placeholder records).
test("verifyPassword returns false for unsupported algorithm (no throw)", async () => {
  const got = await verifyPassword("hunter2", "pep", {
    algo: "bcrypt" as any,
    iterations: 10,
    salt: "AAAA",
    hash: "AAAA",
  });
  expect(got).toBe(false);
});

test("verifyPassword returns false for algo:\"oidc\" placeholder record", async () => {
  const got = await verifyPassword("anything", "pep", {
    algo: "oidc" as any,
    iterations: 0,
    salt: "",
    hash: "",
  });
  expect(got).toBe(false);
});

test("hashPassword throws MissingPepperError on empty pepper", async () => {
  await expect(hashPassword("hunter2", "")).rejects.toBeInstanceOf(
    MissingPepperError,
  );
});

test("verifyPassword throws MissingPepperError on empty pepper", async () => {
  const record = await hashPassword("hunter2", "pep");
  await expect(verifyPassword("hunter2", "", record)).rejects.toBeInstanceOf(
    MissingPepperError,
  );
});
