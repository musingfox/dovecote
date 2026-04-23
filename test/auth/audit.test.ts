import { test, expect, spyOn } from "bun:test";
import { writeAudit } from "../../src/auth/audit";
import { MockKV } from "../helpers/mock-kv";
import type { Env } from "../../src/types";

test("writeAudit happy path - console log and KV put with TTL", async () => {
  const mockKV = new MockKV();
  const promises: Promise<any>[] = [];

  const env: Env = {
    OAUTH_KV: mockKV as any,
    MCP_AUTH_TOKEN: "test",
    OAUTH_PASSWORD: "test",
    COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length",
  };

  const ctx = {
    waitUntil: (p: Promise<any>) => {
      promises.push(p);
    },
    passThroughOnException: () => {},
  } as any;

  // Spy on console.log
  const consoleLogSpy = spyOn(console, "log");

  // Spy on KV put
  const kvPutSpy = spyOn(mockKV, "put");

  // Call writeAudit
  writeAudit(env, ctx, {
    event: "authorize",
    userId: "operator",
    ok: true,
  });

  // Wait for promises
  await Promise.all(promises);

  // Assert console.log called once
  expect(consoleLogSpy).toHaveBeenCalledTimes(1);

  const loggedData = JSON.parse(consoleLogSpy.mock.calls[0][0]);
  expect(loggedData.event).toBe("authorize");
  expect(loggedData.userId).toBe("operator");
  expect(loggedData.ok).toBe(true);
  expect(typeof loggedData.ts).toBe("number");

  // Assert waitUntil called once
  expect(promises.length).toBe(1);

  // Assert KV put called with correct key pattern and TTL
  expect(kvPutSpy).toHaveBeenCalledTimes(1);

  const kvCall = kvPutSpy.mock.calls[0];
  const key = kvCall[0];
  const value = kvCall[1];
  const options = kvCall[2];

  expect(key).toMatch(/^audit:\d+:[0-9a-f-]{36}$/i);
  expect(options?.expirationTtl).toBe(7_776_000);

  const storedData = JSON.parse(value);
  expect(storedData.event).toBe("authorize");

  // Cleanup
  consoleLogSpy.mockRestore();
  kvPutSpy.mockRestore();
});

test("writeAudit failure tolerance - KV.put rejects", async () => {
  const mockKV = {
    put: async () => {
      throw new Error("KV failure");
    },
  };

  const promises: Promise<any>[] = [];

  const env: Env = {
    OAUTH_KV: mockKV as any,
    MCP_AUTH_TOKEN: "test",
    OAUTH_PASSWORD: "test",
    COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length",
  };

  const ctx = {
    waitUntil: (p: Promise<any>) => {
      promises.push(p);
    },
    passThroughOnException: () => {},
  } as any;

  const consoleLogSpy = spyOn(console, "log");

  // Should not throw
  expect(() => {
    writeAudit(env, ctx, {
      event: "authorize",
      userId: "operator",
      ok: true,
    });
  }).not.toThrow();

  // Wait for promises to settle (should absorb error)
  await Promise.allSettled(promises);

  // Console log should still have happened
  expect(consoleLogSpy).toHaveBeenCalledTimes(1);

  consoleLogSpy.mockRestore();
});
