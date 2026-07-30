import { test, expect } from "bun:test";
import {
  issueToken,
  verifyToken,
  revokeToken,
  deleteTokenEntries,
  getTokenMetadataByTokenId,
  InvalidScopeError,
  MissingPepperError,
  KVWriteError,
  TOKEN_PREFIX,
  KV_USER_NAMESPACE,
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
} from "../../src/auth/api-token";
import type { TokenMetadata } from "../../src/auth/api-token";
import type { Env } from "../../src/types";
import { MockKV } from "../helpers/mock-kv";

// Custom MockKV for simulating KV write failures
class FailingMockKV extends MockKV {
  constructor(
    private readonly failOn: ("put" | "get" | "delete")[] = [],
    private readonly errorMessage: string = "KV operation failed"
  ) {
    super();
  }

  override async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number; metadata?: any }
  ): Promise<void> {
    if (this.failOn.includes("put")) {
      throw new Error(this.errorMessage);
    }
    return super.put(key, value, options);
  }

  override async get(key: string, options?: { type?: "text" | "json" } | "text" | "json"): Promise<any> {
    if (this.failOn.includes("get")) {
      throw new Error(this.errorMessage);
    }
    return super.get(key, options);
  }

  override async delete(key: string): Promise<void> {
    if (this.failOn.includes("delete")) {
      throw new Error(this.errorMessage);
    }
    return super.delete(key);
  }
}

function createEnv(hmacPepper: string, kv: MockKV = new MockKV()): Env {
  return {
    OAUTH_KV: kv,
    HMAC_PEPPER: hmacPepper,
  } as unknown as Env;
}

// C2.2.a tests
test("C2.2.a-1: Issue token with valid scopes and label", async () => {
  const env = createEnv("test-pepper-32-characters-long");
  const now = Date.now();

  const result = await issueToken(
    {
      userId: "user123",
      scopes: ["dovecote:notify"],
      label: "ci",
      ttlSeconds: DEFAULT_TTL_SECONDS,
    },
    env,
    now
  );

  // Verify token format
  expect(result.token).toMatch(/^dvct_[A-Za-z0-9_-]{32}$/);

  // Verify tokenId exists and is base64url encoded
  expect(result.tokenId).toBeDefined();
  expect(result.tokenId).toMatch(/^[A-Za-z0-9_-]+$/);

  // Verify expiresAt is in MILLISECONDS (now + 7776000000)
  expect(result.expiresAt).toBe(now + 7776000000);

  // Verify KV has the token metadata (3 entries per token after C-Index-Issue:
  // apitoken:<id>, apitoken_hash:<hash>, apitoken_user:<uid>:<id>)
  const store = (env.OAUTH_KV as unknown as MockKV).getStore();
  expect(store.size).toBe(3);

  // Find the metadata entry
  let metadata: TokenMetadata | null = null;
  for (const [, value] of store) {
    if (typeof value.value === "string" && value.value.startsWith("{")) {
      try {
        metadata = JSON.parse(value.value);
        break;
      } catch {
        // Skip non-JSON values
      }
    }
  }

  expect(metadata).toBeDefined();
  expect(metadata?.userId).toBe("user123");
  expect(metadata?.scopes).toEqual(["dovecote:notify"]);
  expect(metadata?.label).toBe("ci");
  expect(metadata?.tokenId).toBe(result.tokenId);
  expect(metadata?.hash).toBeDefined();
  expect(metadata?.hash).not.toBe(result.token); // Hash should not equal token
  expect(metadata?.createdAt).toBe(now);
  expect(metadata?.expiresAt).toBe(now + 7776000000);
});

test("C2.2.a-2: Issue token without label (label is optional)", async () => {
  const env = createEnv("test-pepper-32-characters-long");
  const now = Date.now();

  const result = await issueToken(
    {
      userId: "user456",
      scopes: ["dovecote:admin"],
    },
    env,
    now
  );

  expect(result.token).toMatch(/^dvct_[A-Za-z0-9_-]{32}$/);
  expect(result.tokenId).toBeDefined();

  // Verify metadata
  const store = (env.OAUTH_KV as unknown as MockKV).getStore();
  let metadata: TokenMetadata | null = null;
  for (const [, value] of store) {
    if (typeof value.value === "string" && value.value.startsWith("{")) {
      try {
        metadata = JSON.parse(value.value);
        break;
      } catch {
        // Skip non-JSON values
      }
    }
  }

  expect(metadata).toBeDefined();
  expect(metadata?.label).toBeUndefined();
});

test("C2.2.a-3: Issue token with multiple scopes", async () => {
  const env = createEnv("test-pepper-32-characters-long");
  const now = Date.now();

  const result = await issueToken(
    {
      userId: "user789",
      scopes: ["dovecote:notify", "dovecote:admin"],
      ttlSeconds: 3600, // 1 hour
    },
    env,
    now
  );

  expect(result.token).toMatch(/^dvct_[A-Za-z0-9_-]{32}$/);
  expect(result.expiresAt).toBe(now + 3600 * 1000); // 1 hour in ms

  // Verify metadata
  const store = (env.OAUTH_KV as unknown as MockKV).getStore();
  let metadata: TokenMetadata | null = null;
  for (const [, value] of store) {
    if (typeof value.value === "string" && value.value.startsWith("{")) {
      try {
        metadata = JSON.parse(value.value);
        break;
      } catch {
        // Skip non-JSON values
      }
    }
  }

  expect(metadata).toBeDefined();
  expect(metadata?.scopes).toEqual(["dovecote:notify", "dovecote:admin"]);
});

test("C2.2.a-4: Issue token with invalid scope throws InvalidScopeError", async () => {
  const env = createEnv("test-pepper-32-characters-long");

  await expect(
    issueToken(
      {
        userId: "user123",
        scopes: ["bogus"],
      },
      env
    )
  ).rejects.toThrow(InvalidScopeError);
});

test("C2.2.a-5: Issue token with multiple invalid scopes throws InvalidScopeError", async () => {
  const env = createEnv("test-pepper-32-characters-long");

  await expect(
    issueToken(
      {
        userId: "user123",
        scopes: ["dovecote:notify", "invalid:scope"],
      },
      env
    )
  ).rejects.toThrow(InvalidScopeError);
});

test("C2.2.a-6: Issue token without HMAC_PEPPER throws MissingPepperError", async () => {
  const env = createEnv("");
  // @ts-expect-error - testing missing HMAC_PEPPER
  delete env.HMAC_PEPPER;

  await expect(
    issueToken(
      {
        userId: "user123",
        scopes: ["dovecote:notify"],
      },
      env
    )
  ).rejects.toThrow(MissingPepperError);
});

test("C2.2.a-7: Issue token without HMAC_PEPPER does not write to KV", async () => {
  const env = createEnv("");
  // @ts-expect-error - testing missing HMAC_PEPPER
  delete env.HMAC_PEPPER;
  const kv = new MockKV();

  try {
    await issueToken(
      {
        userId: "user123",
        scopes: ["dovecote:notify"],
      },
      { ...env, OAUTH_KV: kv } as unknown as Env
    );
    expect(true).toBe(false); // Should have thrown
  } catch {
    // Expected
  }

  // Verify no KV write occurred
  expect(kv.getStore().size).toBe(0);
});

test("C2.2.a-8: Issue token when kv.put rejects throws KVWriteError", async () => {
  const kv = new FailingMockKV(["put"]);
  const env = createEnv("test-pepper-32-characters-long", kv);

  await expect(
    issueToken(
      {
        userId: "user123",
        scopes: ["dovecote:notify"],
      },
      env
    )
  ).rejects.toThrow(KVWriteError);
});

test("C2.2.a-9: Issue token respects max TTL (7_776_000 seconds)", async () => {
  const env = createEnv("test-pepper-32-characters-long");
  const now = Date.now();

  // Try to issue with a TTL larger than max
  const result = await issueToken(
    {
      userId: "user123",
      scopes: ["dovecote:notify"],
      ttlSeconds: MAX_TTL_SECONDS + 1000, // Exceeds max
    },
    env,
    now
  );

  // Should be capped at MAX_TTL_SECONDS
  expect(result.expiresAt).toBe(now + MAX_TTL_SECONDS * 1000);
});

test("C2.2.a-10: Issue token with default TTL", async () => {
  const env = createEnv("test-pepper-32-characters-long");
  const now = Date.now();

  const result = await issueToken(
    {
      userId: "user123",
      scopes: ["dovecote:notify"],
      // No ttlSeconds specified
    },
    env,
    now
  );

  expect(result.expiresAt).toBe(now + DEFAULT_TTL_SECONDS * 1000);
});

test("C2.2.a-11: Different tokens have different hashes", async () => {
  const env = createEnv("test-pepper-32-characters-long");

  const result1 = await issueToken(
    {
      userId: "user123",
      scopes: ["dovecote:notify"],
    },
    env
  );

  const result2 = await issueToken(
    {
      userId: "user456",
      scopes: ["dovecote:notify"],
    },
    env
  );

  // Get both metadata entries
  const store = (env.OAUTH_KV as unknown as MockKV).getStore();
  const hashes: string[] = [];
  for (const [, value] of store) {
    if (typeof value.value === "string" && value.value.startsWith("{")) {
      try {
        const metadata = JSON.parse(value.value);
        if (metadata.hash) {
          hashes.push(metadata.hash);
        }
      } catch {
        // Skip non-JSON values
      }
    }
  }

  expect(hashes.length).toBe(4); // 2 tokens * 2 entries each (token + hash)
  // Extract unique hashes
  const uniqueHashes = [...new Set(hashes)];
  expect(uniqueHashes.length).toBe(2);
  expect(uniqueHashes[0]).not.toBe(uniqueHashes[1]);
});

test("C2.2.a-12: Token hash is different from the token string", async () => {
  const env = createEnv("test-pepper-32-characters-long");

  const result = await issueToken(
    {
      userId: "user123",
      scopes: ["dovecote:notify"],
    },
    env
  );

  // Get the metadata
  const store = (env.OAUTH_KV as unknown as MockKV).getStore();
  let metadata: TokenMetadata | null = null;
  for (const [, value] of store) {
    if (typeof value.value === "string" && value.value.startsWith("{")) {
      try {
        metadata = JSON.parse(value.value);
        break;
      } catch {
        // Skip non-JSON values
      }
    }
  }

  expect(metadata).toBeDefined();
  expect(metadata?.hash).not.toBe(result.token);
});

// C2.2.b tests
test("C2.2.b-1: Verify token issued in C2.2.a returns AuthCtx", async () => {
  const env = createEnv("test-pepper-32-characters-long");
  const now = Date.now();

  // First, issue a token
  const issueResult = await issueToken(
    {
      userId: "user123",
      scopes: ["dovecote:notify"],
    },
    env,
    now
  );

  // Then verify it
  const result = await verifyToken(issueResult.token, env, now);

  expect(result.kind).toBe("valid");
  if (result.kind !== "valid") throw new Error("expected valid");
  expect(result.auth).toMatchObject({
    userId: "user123",
    scopes: ["dovecote:notify"],
    tokenId: issueResult.tokenId,
    authMethod: "api_token",
    ip: "unknown",
  });
});

test("C2.2.b-2: Token with flipped byte returns null (hash mismatch)", async () => {
  const env = createEnv("test-pepper-32-characters-long");
  const now = Date.now();

  // Issue a token
  const issueResult = await issueToken(
    {
      userId: "user123",
      scopes: ["dovecote:notify"],
    },
    env,
    now
  );

  // Flip one byte in the token body
  const tokenArray = issueResult.token.split("");
  // Flip the first character after the prefix
  if (tokenArray[TOKEN_PREFIX.length] === "a") {
    tokenArray[TOKEN_PREFIX.length] = "b";
  } else {
    tokenArray[TOKEN_PREFIX.length] = "a";
  }
  const mutatedToken = tokenArray.join("");

  // Verify mutated token: hash will not match anything in KV → invalid
  const result = await verifyToken(mutatedToken, env, now);
  expect(result.kind).toBe("invalid");
});

test("C2.2.b-3: Expired token returns null", async () => {
  const env = createEnv("test-pepper-32-characters-long");
  const now = Date.now();

  // Issue a token with 1 second TTL
  const issueResult = await issueToken(
    {
      userId: "user123",
      scopes: ["dovecote:notify"],
      ttlSeconds: 1,
    },
    env,
    now
  );

  // Verify immediately - should work
  const resultBefore = await verifyToken(issueResult.token, env, now);
  expect(resultBefore.kind).toBe("valid");

  // Move past expiration
  const expiredNow = now + 2000; // 2 seconds later, past the 1 second TTL

  // Verify expired token returns expired outcome
  const resultAfter = await verifyToken(issueResult.token, env, expiredNow);
  expect(resultAfter.kind).toBe("expired");
});

test("C2.2.b-4: Token with expiresAt === now is treated as expired", async () => {
  const env = createEnv("test-pepper-32-characters-long");

  // Issue a token with 0 TTL (expires immediately)
  const issueResult = await issueToken(
    {
      userId: "user123",
      scopes: ["dovecote:notify"],
      ttlSeconds: 0,
    },
    env
  );

  const now = Date.now();

  // Verify at the exact expiration time - should report expired
  const result = await verifyToken(issueResult.token, env, now);
  expect(result.kind).toBe("expired");
});

test("C2.2.b-5: Token not in KV returns invalid", async () => {
  const env = createEnv("test-pepper-32-characters-long");
  const now = Date.now();

  // Create a token that's not in KV (just matching format)
  const fakeToken = "dvct_" + "a".repeat(32);

  const result = await verifyToken(fakeToken, env, now);
  expect(result.kind).toBe("invalid");
});

test("C2.2.b-6: Token not starting with dvct_ returns invalid without KV read", async () => {
  const env = createEnv("test-pepper-32-characters-long");
  const now = Date.now();

  // Mock KV to track calls
  const kvCalls: string[] = [];
  const mockKv = {
    ...env.OAUTH_KV,
    async get(key: string) {
      kvCalls.push(key);
      return null;
    },
  } as any;

  // Token with wrong prefix
  const result = await verifyToken(
    "bogus_token",
    { ...env, OAUTH_KV: mockKv } as unknown as Env,
    now
  );

  expect(result.kind).toBe("invalid");
  // Should not have read from KV (early return on prefix check)
  expect(kvCalls.length).toBe(0);
});

test("C2.2.b-7: kv.get rejects throws KVWriteError", async () => {
  const kv = new FailingMockKV(["get"], "KV read failed");
  const env = createEnv("test-pepper-32-characters-long", kv);

  // Issue a token first so we have something to verify
  const issueResult = await issueToken(
    {
      userId: "user123",
      scopes: ["dovecote:notify"],
    },
    env
  );

  // The token is returned from issueToken, not stored directly in KV
  const token = issueResult.token;
  expect(token).toBeDefined();

  await expect(verifyToken(token!, env, Date.now())).rejects.toThrow(KVWriteError);
});

test("C2.2.b-8: Verify after revoke returns null", async () => {
  const env = createEnv("test-pepper-32-characters-long");
  const now = Date.now();

  // Issue a token
  const issueResult = await issueToken(
    {
      userId: "user123",
      scopes: ["dovecote:notify"],
    },
    env,
    now
  );

  // Verify before revoke
  const beforeRevoke = await verifyToken(issueResult.token, env, now);
  expect(beforeRevoke.kind).toBe("valid");

  // Revoke the token
  await revokeToken({ tokenId: issueResult.tokenId, env }, env);

  // Verify after revoke - should report invalid (KV row gone)
  const afterRevoke = await verifyToken(issueResult.token, env, now);
  expect(afterRevoke.kind).toBe("invalid");
});

test("C2.2.b-9: Multiple tokens with same user but different scopes", async () => {
  const env = createEnv("test-pepper-32-characters-long");
  const now = Date.now();

  // Issue first token
  const result1 = await issueToken(
    {
      userId: "user123",
      scopes: ["dovecote:notify"],
    },
    env,
    now
  );

  // Issue second token with different scopes
  const result2 = await issueToken(
    {
      userId: "user123",
      scopes: ["dovecote:admin", "dovecote:notify"],
    },
    env,
    now
  );

  // Verify both work independently
  const verify1 = await verifyToken(result1.token, env, now);
  expect(verify1.kind).toBe("valid");
  if (verify1.kind !== "valid") throw new Error("expected valid");
  expect(verify1.auth.scopes).toEqual(["dovecote:notify"]);

  const verify2 = await verifyToken(result2.token, env, now);
  expect(verify2.kind).toBe("valid");
  if (verify2.kind !== "valid") throw new Error("expected valid");
  expect(verify2.auth.scopes).toEqual(["dovecote:admin", "dovecote:notify"]);
});

test("C2.2.b-10: Verify with wrong HMAC_PEPPER returns null", async () => {
  const env1 = createEnv("pepper-one");
  const env2 = createEnv("pepper-two");
  const now = Date.now();

  // Issue with env1's pepper
  const issueResult = await issueToken(
    {
      userId: "user123",
      scopes: ["dovecote:notify"],
    },
    env1,
    now
  );

  // Verify with env2's different pepper - hash mismatch → invalid
  const result = await verifyToken(issueResult.token, env2, now);
  expect(result.kind).toBe("invalid");
});

// C2.2.c tests
test("C2.2.c-1: Revoke issued token returns revoked: true", async () => {
  const env = createEnv("test-pepper-32-characters-long");
  const now = Date.now();

  // Issue a token
  const issueResult = await issueToken(
    {
      userId: "user123",
      scopes: ["dovecote:notify"],
    },
    env,
    now
  );

  // Revoke the token
  const result = await revokeToken({ tokenId: issueResult.tokenId, env }, env);

  expect(result.revoked).toBe(true);

  // Verify KV key is deleted
  const kvKey = "apitoken:" + issueResult.tokenId;
  const stored = await env.OAUTH_KV.get(kvKey, "json");
  expect(stored).toBeNull();
});

test("C2.2.c-2: Revoke unknown tokenId returns revoked: false", async () => {
  const env = createEnv("test-pepper-32-characters-long");

  // Revoke a tokenId that doesn't exist
  const result = await revokeToken({ tokenId: "nonexistent-id", env }, env);

  expect(result.revoked).toBe(false);
});

test("C2.2.c-3: kv.delete rejects throws KVWriteError", async () => {
  const kv = new FailingMockKV(["delete"], "KV delete failed");
  const env = createEnv("test-pepper-32-characters-long", kv);

  // Create a token first
  const issueResult = await issueToken(
    {
      userId: "user123",
      scopes: ["dovecote:notify"],
    },
    env
  );

  await expect(revokeToken({ tokenId: issueResult.tokenId, env }, env)).rejects.toThrow(
    KVWriteError
  );
});

test("C2.2.c-4: After revoke, subsequent verify returns null", async () => {
  const env = createEnv("test-pepper-32-characters-long");
  const now = Date.now();

  // Issue a token
  const issueResult = await issueToken(
    {
      userId: "user123",
      scopes: ["dovecote:notify"],
    },
    env,
    now
  );

  // Verify before revoke
  const before = await verifyToken(issueResult.token, env, now);
  expect(before.kind).toBe("valid");

  // Revoke
  await revokeToken({ tokenId: issueResult.tokenId, env }, env);

  // Verify after revoke
  const after = await verifyToken(issueResult.token, env, now);
  expect(after.kind).toBe("invalid");
});

test("C2.2.c-5: Revoke same token twice returns revoked: false on second call", async () => {
  const env = createEnv("test-pepper-32-characters-long");
  const now = Date.now();

  // Issue a token
  const issueResult = await issueToken(
    {
      userId: "user123",
      scopes: ["dovecote:notify"],
    },
    env,
    now
  );

  // First revoke
  const first = await revokeToken({ tokenId: issueResult.tokenId, env }, env);
  expect(first.revoked).toBe(true);

  // Second revoke (token already deleted)
  const second = await revokeToken({ tokenId: issueResult.tokenId, env }, env);
  expect(second.revoked).toBe(false);
});

// C2.2.d test
test("C2.2.d-1: TypeScript compiles with HMAC_PEPPER in Env", async () => {
  // This test verifies that the Env type includes HMAC_PEPPER
  // The actual compilation check is done by bun tsc --noEmit
  // If this file compiles without errors, the contract is satisfied

  // Create a mock handler that uses HMAC_PEPPER
  const handler = async (env: Env) => {
    // This line will cause a compile error if HMAC_PEPPER is not in Env
    const pepper = env.HMAC_PEPPER;
    return pepper;
  };

  expect(typeof handler).toBe("function");
});

// ============================================================
// C-Index-Issue / C-Index-Delete — apitoken_user:<uid>:<id> index
// ============================================================

test("C-Index-Issue: issueToken writes apitoken_user:<uid>:<id> index", async () => {
  const env = createEnv("test-pepper-32-characters-long");
  const result = await issueToken({ userId: "alice", scopes: ["dovecote:notify"] }, env);
  const indexKey = KV_USER_NAMESPACE + "alice:" + result.tokenId;
  const indexValue = await env.OAUTH_KV.get(indexKey);
  expect(indexValue).toBe("");
});

test("C-Index-Issue: KV.list prefix scan finds the issued token", async () => {
  const env = createEnv("test-pepper-32-characters-long");
  const result = await issueToken({ userId: "alice", scopes: ["dovecote:notify"] }, env);
  const listed = await env.OAUTH_KV.list({ prefix: KV_USER_NAMESPACE + "alice:" });
  const names = (listed.keys as { name: string }[]).map((k) => k.name);
  expect(names).toContain(KV_USER_NAMESPACE + "alice:" + result.tokenId);
});

test("C-Index-Issue: renew path — new tokenId index exists, old removed", async () => {
  const env = createEnv("test-pepper-32-characters-long");

  // Issue bob's original token
  const original = await issueToken({ userId: "bob", scopes: ["dovecote:notify"] }, env);

  // Simulate admin renewing bob's token: issue new + delete old (api-v1 ordering)
  const oldMeta = await getTokenMetadataByTokenId(original.tokenId, env);
  expect(oldMeta).not.toBeNull();

  const replacement = await issueToken(
    { userId: "bob", scopes: ["dovecote:notify"] },
    env
  );
  await deleteTokenEntries(oldMeta!, env);

  const oldIndexKey = KV_USER_NAMESPACE + "bob:" + original.tokenId;
  const newIndexKey = KV_USER_NAMESPACE + "bob:" + replacement.tokenId;
  expect(await env.OAUTH_KV.get(oldIndexKey)).toBeNull();
  expect(await env.OAUTH_KV.get(newIndexKey)).toBe("");
});

test("C-Index-Delete: revokeToken removes apitoken_user:<uid>:<id>", async () => {
  const env = createEnv("test-pepper-32-characters-long");
  const result = await issueToken({ userId: "alice", scopes: ["dovecote:notify"] }, env);
  const indexKey = KV_USER_NAMESPACE + "alice:" + result.tokenId;
  expect(await env.OAUTH_KV.get(indexKey)).toBe("");
  await revokeToken({ tokenId: result.tokenId, env }, env);
  expect(await env.OAUTH_KV.get(indexKey)).toBeNull();
});

test("C-Index-Delete: deleteTokenEntries removes apitoken_user:<uid>:<id>", async () => {
  const env = createEnv("test-pepper-32-characters-long");
  const result = await issueToken({ userId: "alice", scopes: ["dovecote:notify"] }, env);
  const meta = await getTokenMetadataByTokenId(result.tokenId, env);
  await deleteTokenEntries(meta!, env);
  const indexKey = KV_USER_NAMESPACE + "alice:" + result.tokenId;
  expect(await env.OAUTH_KV.get(indexKey)).toBeNull();
});

test("C-Index-Delete: revoke pre-backfill token (no index) returns revoked:true, no error", async () => {
  const env = createEnv("test-pepper-32-characters-long");
  // Issue then manually erase the index to simulate pre-backfill state
  const result = await issueToken({ userId: "alice", scopes: ["dovecote:notify"] }, env);
  await env.OAUTH_KV.delete(KV_USER_NAMESPACE + "alice:" + result.tokenId);
  // Now revoke — should still succeed
  const revoke = await revokeToken({ tokenId: result.tokenId, env }, env);
  expect(revoke.revoked).toBe(true);
});
