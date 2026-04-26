import { test, expect } from "bun:test";
import { checkRateLimit } from "../../src/auth/rate-limit.js";
import { MockKV } from "../helpers/mock-kv.js";

test("rate limit: 1st call returns allowed=true, current=1", async () => {
  const kv = new MockKV() as any;
  const result = await checkRateLimit(kv, "1.2.3.4");

  expect(result).toEqual({ allowed: true, current: 1 });

  const stored = kv.getStore().get("rl:revoke:1.2.3.4");
  expect(stored?.value).toBe("1");
  expect(stored?.expirationTtl).toBe(60);
});

test("rate limit: 5 consecutive calls, 5th returns allowed=true, current=5", async () => {
  const kv = new MockKV() as any;
  const ip = "1.2.3.4";

  for (let i = 1; i <= 5; i++) {
    const result = await checkRateLimit(kv, ip);
    expect(result).toEqual({ allowed: true, current: i });
  }
});

test("rate limit: 6th call returns allowed=false, current=6", async () => {
  const kv = new MockKV() as any;
  const ip = "1.2.3.4";

  // Make 5 calls
  for (let i = 1; i <= 5; i++) {
    await checkRateLimit(kv, ip);
  }

  // 6th call should be blocked
  const result = await checkRateLimit(kv, ip);
  expect(result).toEqual({ allowed: false, current: 6 });
});

test("rate limit: different IPs are independent", async () => {
  const kv = new MockKV() as any;

  // Make 5 calls from first IP
  for (let i = 1; i <= 5; i++) {
    await checkRateLimit(kv, "1.2.3.4");
  }

  // First call from different IP should succeed
  const result = await checkRateLimit(kv, "5.6.7.8");
  expect(result).toEqual({ allowed: true, current: 1 });
});

test("rate limit: pre-populated KV at limit (5), next call returns allowed=false, current=6", async () => {
  const kv = new MockKV() as any;

  // Pre-populate with count of 5
  await kv.put("rl:revoke:1.2.3.4", "5", { expirationTtl: 60 });

  // Next call should be blocked
  const result = await checkRateLimit(kv, "1.2.3.4");
  expect(result).toEqual({ allowed: false, current: 6 });
});

test("rate limit: KV.get throws, returns fail-open (allowed=true, current=0)", async () => {
  const kv = {
    get: async () => {
      throw new Error("KV error");
    },
    put: async () => {},
  } as any;

  const result = await checkRateLimit(kv, "1.2.3.4");
  expect(result).toEqual({ allowed: true, current: 0 });
});

test("rate limit: bootstrap namespace - 5 calls allowed, 6th denied", async () => {
  const kv = new MockKV();
  const ip = "1.2.3.4";

  // First 5 calls should be allowed
  for (let i = 0; i < 5; i++) {
    const result = await checkRateLimit(kv as any, ip, "bootstrap");
    expect(result.allowed).toBe(true);
    expect(result.current).toBe(i + 1);
  }

  // Verify KV has the bootstrap namespace key
  const bootstrapKey = kv.getStore().get("rl:bootstrap:1.2.3.4");
  expect(bootstrapKey).toBeTruthy();
  expect(bootstrapKey?.value).toBe("5");

  // 6th call should be denied
  const result6 = await checkRateLimit(kv as any, ip, "bootstrap");
  expect(result6.allowed).toBe(false);
  expect(result6.current).toBe(6);
});

test("rate limit: default namespace (revoke) backward compat", async () => {
  const kv = new MockKV();
  const ip = "1.2.3.4";

  // Call without namespace argument (defaults to "revoke")
  const result = await checkRateLimit(kv as any, ip);
  expect(result.allowed).toBe(true);
  expect(result.current).toBe(1);

  // Verify KV uses revoke namespace key
  const revokeKey = kv.getStore().get("rl:revoke:1.2.3.4");
  expect(revokeKey).toBeTruthy();
  expect(revokeKey?.value).toBe("1");

  // Verify no bootstrap key
  const bootstrapKey = kv.getStore().get("rl:bootstrap:1.2.3.4");
  expect(bootstrapKey).toBeUndefined();
});

test("rate limit: separate namespaces - bootstrap and revoke independent", async () => {
  const kv = new MockKV();
  const ip = "1.2.3.4";

  // Make 6 bootstrap calls (6th should fail)
  for (let i = 0; i < 6; i++) {
    await checkRateLimit(kv as any, ip, "bootstrap");
  }

  // Bootstrap namespace should be rate limited
  const bootstrapResult = await checkRateLimit(kv as any, ip, "bootstrap");
  expect(bootstrapResult.allowed).toBe(false);
  expect(bootstrapResult.current).toBe(7);

  // Revoke namespace should still allow (independent counter)
  const revokeResult = await checkRateLimit(kv as any, ip);
  expect(revokeResult.allowed).toBe(true);
  expect(revokeResult.current).toBe(1);

  // Verify both keys exist
  expect(kv.getStore().has("rl:bootstrap:1.2.3.4")).toBe(true);
  expect(kv.getStore().has("rl:revoke:1.2.3.4")).toBe(true);
});
