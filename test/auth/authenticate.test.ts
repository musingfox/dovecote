import { test, expect } from "bun:test";
import { authenticateUserCredentials } from "../../src/auth/authenticate.js";
import { hashPassword } from "../../src/auth/password.js";
import { SCOPES_SUPPORTED } from "../../src/auth/scopes.js";
import { MockKV } from "../helpers/mock-kv.js";
import type { Env } from "../../src/types.js";

const PEPPER = "test-pepper";

function makeEnv(kv: MockKV, overrides: Partial<Env> = {}): Env {
  return {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "",
    COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length",
    HMAC_PEPPER: PEPPER,
    ...overrides,
  } as Env;
}

async function seedUser(
  kv: MockKV,
  username: string,
  password: string,
  scopes: string[],
) {
  const rec = await hashPassword(password, PEPPER);
  await kv.put(
    `user:${username}`,
    JSON.stringify({
      username,
      algo: rec.algo,
      iterations: rec.iterations,
      salt: rec.salt,
      hash: rec.hash,
      scopes,
      createdAt: "2026-05-22T00:00:00Z",
    }),
  );
}

test("authenticate: KV-seeded user + correct password → success", async () => {
  const kv = new MockKV();
  await seedUser(kv, "alice", "correct", ["dovecote:notify"]);
  const env = makeEnv(kv);

  const got = await authenticateUserCredentials(
    { submittedUsername: "alice", submittedPassword: "correct" },
    env,
  );
  expect(got).toEqual({
    userId: "alice",
    scopes: ["dovecote:notify"],
  });
});

test("authenticate: KV-seeded user + wrong password → null", async () => {
  const kv = new MockKV();
  await seedUser(kv, "alice", "correct", ["dovecote:notify"]);
  const env = makeEnv(kv);

  const got = await authenticateUserCredentials(
    { submittedUsername: "alice", submittedPassword: "wrong" },
    env,
  );
  expect(got).toBeNull();
});

test("authenticate: uppercase username normalized to lowercase for lookup", async () => {
  const kv = new MockKV();
  await seedUser(kv, "alice", "correct", ["dovecote:notify"]);
  const env = makeEnv(kv);

  const got = await authenticateUserCredentials(
    { submittedUsername: "ALICE", submittedPassword: "correct" },
    env,
  );
  expect(got).toEqual({
    userId: "alice",
    scopes: ["dovecote:notify"],
  });
});

test("authenticate: invalid charset username → null with no KV read", async () => {
  const kv = new MockKV();
  let reads = 0;
  const wrapped = new Proxy(kv, {
    get(target, prop) {
      if (prop === "get") {
        return async (...args: any[]) => {
          reads++;
          return (target as any).get(...args);
        };
      }
      return (target as any)[prop];
    },
  });
  const env = makeEnv(wrapped as any);

  const got = await authenticateUserCredentials(
    { submittedUsername: "al:ice", submittedPassword: "x" },
    env,
  );
  expect(got).toBeNull();
  expect(reads).toBe(0);
});

test("authenticate: empty KV + OAUTH_PASSWORD set + operator/legacy-pass → legacy success", async () => {
  const kv = new MockKV();
  const env = makeEnv(kv, { OAUTH_PASSWORD: "legacy-pass" });

  const got = await authenticateUserCredentials(
    { submittedUsername: "operator", submittedPassword: "legacy-pass" },
    env,
  );
  expect(got).toEqual({
    userId: "operator",
    scopes: [...SCOPES_SUPPORTED],
  });
});

test("authenticate: empty KV + no legacy match + ghost → null", async () => {
  const kv = new MockKV();
  const env = makeEnv(kv, { OAUTH_PASSWORD: "legacy-pass" });

  const got = await authenticateUserCredentials(
    { submittedUsername: "ghost", submittedPassword: "x" },
    env,
  );
  expect(got).toBeNull();
});

test("authenticate: alice seeded in KV, operator still authenticates via legacy", async () => {
  // Back-compat: KV has user:alice but no user:operator. Submitting operator
  // with the legacy password should still succeed via the legacy fallback,
  // because the KV lookup for user:operator misses and OAUTH_PASSWORD is set.
  const kv = new MockKV();
  await seedUser(kv, "alice", "alice-pass", ["dovecote:notify"]);
  const env = makeEnv(kv, { OAUTH_PASSWORD: "legacy" });

  const got = await authenticateUserCredentials(
    { submittedUsername: "operator", submittedPassword: "legacy" },
    env,
  );
  expect(got).toEqual({
    userId: "operator",
    scopes: [...SCOPES_SUPPORTED],
  });
});
