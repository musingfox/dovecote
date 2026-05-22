import { test, expect } from "bun:test";
import { $ } from "bun";
import { verifyPassword } from "../../src/auth/password.js";

const SCRIPT = "scripts/seed-user.mjs";

async function runScript(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const res = await $`node ${SCRIPT} ${args}`.nothrow().quiet();
  return {
    stdout: res.stdout.toString(),
    stderr: res.stderr.toString(),
    exitCode: res.exitCode,
  };
}

test("seed-user: full args produces wrangler kv key put with valid record", async () => {
  const result = await runScript([
    "--username", "alice",
    "--password", "hunter2",
    "--scopes", "dovecote:notify,dovecote:admin",
    "--pepper", "test-pepper",
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("wrangler kv key put");
  expect(result.stdout).toContain('"user:alice"');

  // Extract the JSON payload (everything between single quotes after the key)
  const match = result.stdout.match(/'(\{.*\})'/);
  expect(match).not.toBeNull();
  const payload = JSON.parse(match![1]!);
  expect(payload.username).toBe("alice");
  expect(payload.algo).toBe("pbkdf2-sha256");
  expect(payload.iterations).toBe(100_000);
  expect(typeof payload.salt).toBe("string");
  expect(typeof payload.hash).toBe("string");
  expect(payload.scopes).toEqual(["dovecote:notify", "dovecote:admin"]);
  expect(typeof payload.createdAt).toBe("string");
});

test("seed-user: missing password → stderr non-empty, exit 1", async () => {
  const result = await runScript([
    "--username", "alice",
    "--scopes", "dovecote:notify",
    "--pepper", "test-pepper",
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.length).toBeGreaterThan(0);
});

test("seed-user: unsupported scope → stderr, exit 1", async () => {
  const result = await runScript([
    "--username", "alice",
    "--password", "x",
    "--scopes", "dovecote:bogus",
    "--pepper", "test-pepper",
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.length).toBeGreaterThan(0);
});

test("seed-user: invalid charset username AL:ICE → stderr, exit 1", async () => {
  const result = await runScript([
    "--username", "AL:ICE",
    "--password", "x",
    "--scopes", "dovecote:notify",
    "--pepper", "test-pepper",
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.length).toBeGreaterThan(0);
});

test("seed-user: dot in username alice.doe → stderr, exit 1", async () => {
  const result = await runScript([
    "--username", "alice.doe",
    "--password", "x",
    "--scopes", "dovecote:notify",
    "--pepper", "test-pepper",
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.length).toBeGreaterThan(0);
});

test("seed-user: cross-validate — server verifyPassword accepts script-generated hash", async () => {
  const PEPPER = "cross-validate-pepper";
  const PASSWORD = "hunter2-cross-check";
  const result = await runScript([
    "--username", "alice",
    "--password", PASSWORD,
    "--scopes", "dovecote:notify",
    "--pepper", PEPPER,
  ]);
  expect(result.exitCode).toBe(0);

  const match = result.stdout.match(/'(\{.*\})'/);
  expect(match).not.toBeNull();
  const payload = JSON.parse(match![1]!);

  const ok = await verifyPassword(PASSWORD, PEPPER, {
    algo: payload.algo,
    iterations: payload.iterations,
    salt: payload.salt,
    hash: payload.hash,
  });
  expect(ok).toBe(true);

  const bad = await verifyPassword("wrong-password", PEPPER, {
    algo: payload.algo,
    iterations: payload.iterations,
    salt: payload.salt,
    hash: payload.hash,
  });
  expect(bad).toBe(false);
});
