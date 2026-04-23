import { test, expect } from "bun:test";
import { MockKV } from "../helpers/mock-kv.js";
import { readEnvProfile } from "../../src/storage/env-store.js";

test("readEnvProfile returns value when profile exists", async () => {
  const kv = new MockKV();
  await kv.put("env:production", "API_KEY=abc\nDB=pg");

  const result = await readEnvProfile(kv as any, "production");

  expect(result).toBe("API_KEY=abc\nDB=pg");
});

test("readEnvProfile returns null when profile does not exist", async () => {
  const kv = new MockKV();

  const result = await readEnvProfile(kv as any, "staging");

  expect(result).toBeNull();
});

test("readEnvProfile returns empty string when profile is empty", async () => {
  const kv = new MockKV();
  await kv.put("env:empty", "");

  const result = await readEnvProfile(kv as any, "empty");

  expect(result).toBe("");
});
