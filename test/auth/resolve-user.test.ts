import { test, expect } from "bun:test";
import { resolveUserId } from "../../src/auth/resolve-user.js";
import { hashPassword } from "../../src/auth/password.js";
import { MockKV } from "../helpers/mock-kv.js";
import type { Env } from "../../src/types.js";

const PEPPER = "test-pepper";

function makeEnv(kv: MockKV): Env {
  return {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "",
    COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length",
    HMAC_PEPPER: PEPPER,
  } as Env;
}

async function seed(kv: MockKV, username: string, password: string, scopes: string[]) {
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
    }),
  );
}

test("resolveUserId form: KV-seeded credentials → userId + scopes", async () => {
  const kv = new MockKV();
  await seed(kv, "alice", "correct", ["dovecote:notify"]);
  const env = makeEnv(kv);

  const got = await resolveUserId(
    { kind: "form", username: "alice", password: "correct" },
    env,
  );
  expect(got).toEqual({ userId: "alice", scopes: ["dovecote:notify"] });
});

test("resolveUserId form: wrong password → null", async () => {
  const kv = new MockKV();
  await seed(kv, "alice", "correct", ["dovecote:notify"]);
  const env = makeEnv(kv);

  const got = await resolveUserId(
    { kind: "form", username: "alice", password: "wrong" },
    env,
  );
  expect(got).toBeNull();
});
