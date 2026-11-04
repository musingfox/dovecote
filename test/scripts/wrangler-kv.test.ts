/**
 * WizardLocalTokenMint contract tests — makeWranglerKv adapter + issueToken
 * driven through it (the wizard's local-mint path, no server endpoint).
 */
import { test, expect } from "bun:test";
import {
  makeWranglerKv,
  type WranglerRunResult,
  type WranglerRunner,
} from "../../scripts/lib/wrangler-kv.js";
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
  // the user-index value is "" — wrangler 4.81 refuses it positionally
  expect(calls[2]![7]).toBe("--path");
  expect(calls[0]![7]).not.toBe("--path");
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

test("WizardLocalTokenMint: an empty value is written via --path to an empty temp file, removed afterwards", async () => {
  let fileSeen: { path: string; exists: boolean; size: number } | undefined;
  const calls: string[][] = [];
  const runner: WranglerRunner = async (args) => {
    calls.push(args);
    const path = args[args.indexOf("--path") + 1]!;
    const f = Bun.file(path);
    fileSeen = { path, exists: await f.exists(), size: f.size };
    return { code: 0 };
  };
  const kv = makeWranglerKv("staging", runner);
  await kv.put("apitoken_user:u1:t1", "", { expirationTtl: 60 });

  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual([
    "kv",
    "key",
    "put",
    "--remote",
    "--binding",
    "OAUTH_KV",
    "apitoken_user:u1:t1",
    "--path",
    fileSeen!.path,
    "--ttl",
    "60",
    "--env",
    "staging",
  ]);
  expect(fileSeen!.exists).toBe(true);
  expect(fileSeen!.size).toBe(0);
  expect(await Bun.file(fileSeen!.path).exists()).toBe(false);
});

test("WizardLocalTokenMint: the empty-value temp file is removed even when wrangler fails", async () => {
  let path = "";
  const runner: WranglerRunner = (args) => {
    path = args[args.indexOf("--path") + 1]!;
    return { code: 1, stderr: "boom" };
  };
  const kv = makeWranglerKv("staging", runner);
  await expect(kv.put("k", "")).rejects.toThrow(/k/);
  expect(path).not.toBe("");
  expect(await Bun.file(path).exists()).toBe(false);
});

// ---------- WranglerKvGetRecord ----------

/**
 * The stderr wrangler actually emits when `kv key get --remote` misses:
 * `fetchKVGetValue` throws on a 404 from the CF API values endpoint.
 */
function notFoundStderr(key: string): string {
  return (
    "✘ [ERROR] Failed to fetch https://api.cloudflare.com/client/v4/accounts/acct/" +
    `storage/kv/namespaces/ns/values/${encodeURIComponent(key)} - 404: Not Found);`
  );
}

function makeGetRunner(result: WranglerRunResult): {
  runner: WranglerRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: WranglerRunner = (args) => {
    calls.push(args);
    return result;
  };
  return { runner, calls };
}

test("WranglerKvGetRecord T1: a present key resolves to its stored value verbatim", async () => {
  const { runner } = makeGetRunner({ code: 0, stdout: '{"service":"telegram"}' });
  const kv = makeWranglerKv("staging", runner);
  await expect(kv.get("channel:telegram-ops")).resolves.toBe('{"service":"telegram"}');
});

test("WranglerKvGetRecord T2: get() targets the deployed namespace — --remote, OAUTH_KV binding, --env last", async () => {
  const { runner, calls } = makeGetRunner({ code: 0, stdout: "{}" });
  const kv = makeWranglerKv("production", runner);
  await kv.get("channel:telegram-ops");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual([
    "kv",
    "key",
    "get",
    "--remote",
    "--binding",
    "OAUTH_KV",
    "channel:telegram-ops",
    "--env",
    "production",
  ]);
});

test("WranglerKvGetRecord T3: a missing key resolves to null, not an error", async () => {
  const { runner } = makeGetRunner({
    code: 1,
    stderr: notFoundStderr("channel:telegram-nope"),
  });
  const kv = makeWranglerKv("staging", runner);
  await expect(kv.get("channel:telegram-nope")).resolves.toBeNull();
});

test("WranglerKvGetRecord T4: a non-404 wrangler failure throws, naming the key and the exit code", async () => {
  const { runner } = makeGetRunner({ code: 1, stderr: "Authentication error" });
  const kv = makeWranglerKv("staging", runner);
  await expect(kv.get("channel:x")).rejects.toThrow(/channel:x/);
  await expect(kv.get("channel:x")).rejects.toThrow(/1/);
});

test("WranglerKvGetRecord: wrangler's stdout banner is stripped from the returned value", async () => {
  const { runner } = makeGetRunner({
    code: 0,
    stdout: '\u{1F44B} Getting value...\n{"service":"telegram","id":"ops"}',
  });
  const kv = makeWranglerKv("staging", runner);
  await expect(kv.get("channel:telegram-ops")).resolves.toBe(
    '{"service":"telegram","id":"ops"}',
  );
});
