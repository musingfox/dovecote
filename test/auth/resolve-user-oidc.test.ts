import { test, expect } from "bun:test";
import { resolveUserId } from "../../src/auth/resolve-user.js";
import { MockKV } from "../helpers/mock-kv.js";
import type { Env } from "../../src/types.js";

const PEPPER = "test-pepper";

function makeEnv(kv: MockKV): Env {
  return {
    OAUTH_KV: kv as any,
    HMAC_PEPPER: PEPPER,
  } as Env;
}

// C-ResolveUserId-Oidc: brand-new subject → auto-provisioned + default scope
test("oidc arm: new subject auto-provisions user record with default scope", async () => {
  const kv = new MockKV();
  const env = makeEnv(kv);

  const got = await resolveUserId(
    { kind: "oidc", issuer: "https://i.example", subject: "new_user" },
    env,
  );
  expect(got).toEqual({ userId: "new_user", scopes: ["dovecote:notify"] });

  // Verify KV was written
  const raw = await kv.get("user:new_user");
  expect(raw).not.toBeNull();
  const stored = JSON.parse(raw as string);
  expect(stored.username).toBe("new_user");
  expect(stored.algo).toBe("oidc");
  expect(stored.iterations).toBe(0);
  expect(stored.salt).toBe("");
  expect(stored.hash).toBe("");
  expect(stored.scopes).toEqual(["dovecote:notify"]);
  expect(typeof stored.createdAt).toBe("string");
});

// C-ResolveUserId-Oidc: existing record (e.g. admin-promoted) preserved
test("oidc arm: existing user record's scopes are preserved (no KV write)", async () => {
  const kv = new MockKV();
  await kv.put(
    "user:existing",
    JSON.stringify({
      username: "existing",
      algo: "oidc",
      iterations: 0,
      salt: "",
      hash: "",
      scopes: ["dovecote:admin", "dovecote:notify"],
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  const env = makeEnv(kv);

  // Snapshot the raw value to detect any rewrite
  const before = await kv.get("user:existing");

  const got = await resolveUserId(
    { kind: "oidc", issuer: "https://i.example", subject: "existing" },
    env,
  );
  expect(got).toEqual({
    userId: "existing",
    scopes: ["dovecote:admin", "dovecote:notify"],
  });

  const after = await kv.get("user:existing");
  expect(after).toBe(before);
});

// C-ResolveUserId-Oidc: subject that fails normalizeUsername → null
test("oidc arm: subject with disallowed chars returns null (no KV write)", async () => {
  const kv = new MockKV();
  const env = makeEnv(kv);

  const got = await resolveUserId(
    { kind: "oidc", issuer: "https://i.example", subject: "BAD CHAR!" },
    env,
  );
  expect(got).toBeNull();
  // No record written
  expect(kv.getStore().size).toBe(0);
});

// C-ResolveUserId-Oidc: uppercase normalised to lowercase
test("oidc arm: uppercase subject normalised to lowercase and auto-provisioned", async () => {
  const kv = new MockKV();
  const env = makeEnv(kv);

  const got = await resolveUserId(
    { kind: "oidc", issuer: "https://i.example", subject: "UPPERCASE" },
    env,
  );
  expect(got).toEqual({ userId: "uppercase", scopes: ["dovecote:notify"] });
  const raw = await kv.get("user:uppercase");
  expect(raw).not.toBeNull();
});

// ResolveUserOidcOnly: form arm removed; only oidc kind supported (no authenticateUserCredentials, no form input)
test("ResolveUserOidcOnly: form kind is no longer part of ResolveUserInput (compile-time only oidc)", () => {
  // @ts-expect-error - form kind removed
  const bad: import("../../src/auth/resolve-user.js").ResolveUserInput = { kind: "form" as any, username: "x", password: "y" };
  expect((bad as any).kind).toBe("form"); // runtime never reached; documents the contract
});

test("ResolveUserOidcOnly: oidc still works unchanged", async () => {
  const kv = new MockKV();
  const env = makeEnv(kv);
  const got = await resolveUserId(
    { kind: "oidc", issuer: "https://i.example", subject: "only-oidc" },
    env,
  );
  expect(got?.userId).toBe("only-oidc");
});
