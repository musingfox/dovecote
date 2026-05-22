import { test, expect } from "bun:test";
import {
  hashPassword,
  verifyPassword,
  MissingPepperError,
  UnsupportedAlgorithmError,
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

test("verifyPassword throws on unsupported algorithm", async () => {
  await expect(
    verifyPassword("hunter2", "pep", {
      algo: "bcrypt" as any,
      iterations: 10,
      salt: "AAAA",
      hash: "AAAA",
    }),
  ).rejects.toBeInstanceOf(UnsupportedAlgorithmError);
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
