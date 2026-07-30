/**
 * WizardLocalTokenMint contract tests — makeWranglerKv adapter + issueToken
 * driven through it (the wizard's local-mint path, no server endpoint).
 */
import { test, expect } from "bun:test";
import { makeWranglerKv, type WranglerRunner } from "../../scripts/lib/wrangler-kv.js";
import { issueToken, KVWriteError } from "../../src/auth/api-token.js";
import type { Env } from "../../src/types.js";

function makeRunnerStub(failOnCall?: number): {
  runner: WranglerRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: WranglerRunner = (args) => {
    calls.push(args);
    if (failOnCall !== undefined && calls.length === failOnCall) {
      return { code: 1, stderr: "simulated wrangler failure" };
    }
    return { code: 0 };
  };
  return { runner, calls };
}

test("WizardLocalTokenMint T1: put() translates to the exact wrangler argv with --remote and --ttl", async () => {
  const { runner, calls } = makeRunnerStub();
  const kv = makeWranglerKv("staging", runner);
  await kv.put("apitoken:abc", '{"x":1}', { expirationTtl: 7776000 });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual([
    "kv",
    "key",
    "put",
    "--remote",
    "--binding",
    "OAUTH_KV",
    "apitoken:abc",
    '{"x":1}',
    "--ttl",
    "7776000",
    "--env",
    "staging",
  ]);
});

test("WizardLocalTokenMint T2: issueToken over the adapter mints dvct_* via exactly 3 wrangler puts (apitoken:/apitoken_hash:/apitoken_user:u1:)", async () => {
  const { runner, calls } = makeRunnerStub();
  const adapter = makeWranglerKv("staging", runner);
  const env = { OAUTH_KV: adapter, HMAC_PEPPER: "p" } as unknown as Env;

  const result = await issueToken(
    { userId: "u1", scopes: ["dovecote:notify"], ttlSeconds: 7776000 },
    env,
  );

  expect(result.token.startsWith("dvct_")).toBe(true);
  expect(calls).toHaveLength(3);
  // key sits at argv[6] (after kv key put --remote --binding OAUTH_KV)
  const keys = calls.map((argv) => argv[6]!);
  expect(keys[0]!.startsWith("apitoken:")).toBe(true);
  expect(keys[1]!.startsWith("apitoken_hash:")).toBe(true);
  expect(keys[2]!.startsWith("apitoken_user:u1:")).toBe(true);
  // every write carries the TTL and targets the right env
  for (const argv of calls) {
    expect(argv).toContain("--remote");
    expect(argv.slice(-4)).toEqual(["--ttl", "7776000", "--env", "staging"]);
  }
});

test("WizardLocalTokenMint T3: runner non-zero exit on the second key throws KVWriteError", async () => {
  const { runner, calls } = makeRunnerStub(2);
  const adapter = makeWranglerKv("staging", runner);
  const env = { OAUTH_KV: adapter, HMAC_PEPPER: "p" } as unknown as Env;

  await expect(
    issueToken({ userId: "u1", scopes: ["dovecote:notify"], ttlSeconds: 7776000 }, env),
  ).rejects.toBeInstanceOf(KVWriteError);
  expect(calls).toHaveLength(2);
});

test("makeWranglerKv: onWrite progress hook fires per key", async () => {
  const { runner } = makeRunnerStub();
  const seen: string[] = [];
  const kv = makeWranglerKv("production", runner, (key) => seen.push(key));
  await kv.put("apitoken:z", "{}", { expirationTtl: 60 });
  expect(seen).toEqual(["apitoken:z"]);
});
