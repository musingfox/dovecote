import { test, expect } from "bun:test";
import { checkRateLimit } from "../../src/auth/rate-limit.js";

/**
 * Mock KV implementation for testing
 */
class MockKV {
  private store = new Map<string, { value: string; expirationTtl?: number }>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key)?.value || null;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, { value, expirationTtl: options?.expirationTtl });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(): Promise<{ keys: any[]; list_complete: boolean }> {
    return { keys: [], list_complete: true };
  }

  // Helper for tests
  getStore() {
    return this.store;
  }
}

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
