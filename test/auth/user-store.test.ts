import { test, expect } from "bun:test";
import { readUserRecord, normalizeUsername } from "../../src/auth/user-store.js";
import { MockKV } from "../helpers/mock-kv.js";
import type { Env } from "../../src/types.js";

function makeEnv(kv: MockKV): Env {
  return {
    OAUTH_KV: kv as any,
    HMAC_PEPPER: "pep",
  };
}

const sampleRecord = {
  username: "alice",
  algo: "pbkdf2-sha256",
  iterations: 100_000,
  salt: "AAAAAAAAAAAAAAAAAAAAAA==",
  hash: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=",
  scopes: ["dovecote:notify"],
  createdAt: "2026-05-22T00:00:00Z",
};

test("readUserRecord: returns record for seeded user", async () => {
  const kv = new MockKV();
  await kv.put("user:alice", JSON.stringify(sampleRecord));
  const env = makeEnv(kv);

  const got = await readUserRecord("alice", env);
  expect(got).not.toBeNull();
  expect(got!.username).toBe("alice");
  expect(got!.scopes).toEqual(["dovecote:notify"]);
});

test("readUserRecord: lowercases username before lookup", async () => {
  const kv = new MockKV();
  await kv.put("user:alice", JSON.stringify(sampleRecord));
  const env = makeEnv(kv);

  const got = await readUserRecord("ALICE", env);
  expect(got).not.toBeNull();
  expect(got!.username).toBe("alice");
});

test("readUserRecord: invalid charset → null with no KV read", async () => {
  const kv = new MockKV();
  let reads = 0;
  const wrappedKv = {
    ...kv,
    get: async (...args: any[]) => {
      reads++;
      return (kv as any).get(...args);
    },
  };
  const env = makeEnv(wrappedKv as any);

  const got = await readUserRecord("al:ice", env);
  expect(got).toBeNull();
  expect(reads).toBe(0);
});

test("readUserRecord: returns null when KV key missing", async () => {
  const kv = new MockKV();
  const env = makeEnv(kv);

  const got = await readUserRecord("ghost", env);
  expect(got).toBeNull();
});

test("readUserRecord: dot in username → null with no KV read", async () => {
  const kv = new MockKV();
  let reads = 0;
  const wrappedKv = {
    ...kv,
    get: async (...args: any[]) => {
      reads++;
      return (kv as any).get(...args);
    },
  };
  const env = makeEnv(wrappedKv as any);

  const got = await readUserRecord("alice.doe", env);
  expect(got).toBeNull();
  expect(reads).toBe(0);
});

test("normalizeUsername: lowercases valid username", () => {
  expect(normalizeUsername("Alice")).toBe("alice");
});

test("normalizeUsername: rejects colon", () => {
  expect(normalizeUsername("al:ice")).toBeNull();
});

test("normalizeUsername: rejects empty string", () => {
  expect(normalizeUsername("")).toBeNull();
});

test("normalizeUsername: rejects whitespace", () => {
  expect(normalizeUsername("al ice")).toBeNull();
});

test("normalizeUsername: rejects dot", () => {
  expect(normalizeUsername("alice.doe")).toBeNull();
});
