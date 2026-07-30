import { test, expect } from "bun:test";
import { $ } from "bun";
import { pbkdf2Sync } from "node:crypto";

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

// The server-side password verifier is deleted (M1 — auth is dvct-token only;
// seed-user's pbkdf2 fields are inert data per decision L4). Cross-validate the
// script's output against an inline PBKDF2 recomputation instead.
test("seed-user: cross-validate — script-generated hash matches inline PBKDF2 recomputation", async () => {
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

  // seed-user.mjs derives pbkdf2(password + pepper, salt, iterations)
  const salt = Buffer.from(payload.salt, "base64");
  const recomputed = pbkdf2Sync(
    PASSWORD + PEPPER,
    salt,
    payload.iterations,
    32,
    "sha256",
  ).toString("base64");
  expect(payload.hash).toBe(recomputed);
});
