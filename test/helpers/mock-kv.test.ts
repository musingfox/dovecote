import { test, expect } from "bun:test";
import { MockKV } from "./mock-kv.js";

test("MockKV.getWithMetadata returns value and metadata after put", async () => {
  const kv = new MockKV();
  await kv.put("k", "v", { metadata: { foo: 1 } });
  const result = await kv.getWithMetadata("k");
  expect(result).toEqual({ value: "v", metadata: { foo: 1 } });
});

test("MockKV.getWithMetadata returns null for missing key", async () => {
  const kv = new MockKV();
  const result = await kv.getWithMetadata("missing");
  expect(result).toEqual({ value: null, metadata: null });
});

test("MockKV.getWithMetadata returns null after TTL expiry", async () => {
  const kv = new MockKV();
  // Put with 1-second TTL then manually force expiry by manipulating time via store
  await kv.put("ttl-key", "v", { metadata: { bar: 2 }, expirationTtl: 1 });

  // Directly set expiresAt to past via the store
  const store = kv.getStore();
  const entry = store.get("ttl-key");
  if (entry) {
    (entry as any).expiresAt = Date.now() - 1;
  }

  const result = await kv.getWithMetadata("ttl-key");
  expect(result).toEqual({ value: null, metadata: null });
});

test("MockKV.get still works correctly after metadata refactor", async () => {
  const kv = new MockKV();
  await kv.put("key1", "hello");
  expect(await kv.get("key1")).toBe("hello");
  expect(await kv.get("missing")).toBeNull();
});

test("MockKV.get with json type parses JSON", async () => {
  const kv = new MockKV();
  await kv.put("jkey", JSON.stringify({ a: 1 }));
  const result = await kv.get("jkey", "json");
  expect(result).toEqual({ a: 1 });
});

test("MockKV.list filters by prefix", async () => {
  const kv = new MockKV();
  await kv.put("foo:1", "a");
  await kv.put("foo:2", "b");
  await kv.put("bar:1", "c");
  const result = await kv.list({ prefix: "foo:" });
  expect(result.keys.map((k: { name: string }) => k.name)).toEqual(["foo:1", "foo:2"]);
});

test("MockKV.delete removes entry", async () => {
  const kv = new MockKV();
  await kv.put("del-key", "v");
  await kv.delete("del-key");
  expect(await kv.get("del-key")).toBeNull();
});
