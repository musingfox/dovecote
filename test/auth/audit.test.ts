import { test, expect, spyOn } from "bun:test";
import { writeAudit } from "../../src/auth/audit";
import { MockKV } from "../helpers/mock-kv";
import type { Env } from "../../src/types";

test("writeAudit happy path - console log and KV put with TTL", async () => {
  const mockKV = new MockKV();
  const promises: Promise<any>[] = [];

  const env: Env = {
    OAUTH_KV: mockKV as any,
    HMAC_PEPPER: "test-pepper",
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
    authMethod: "none",
    ip: "1.2.3.4",
    scope: "dovecote:notify",
  });

  // Wait for promises
  await Promise.all(promises);

  // Assert console.log called once
  expect(consoleLogSpy).toHaveBeenCalledTimes(1);

  const loggedData = JSON.parse(consoleLogSpy.mock.calls[0]![0] as string);
  expect(loggedData.event).toBe("authorize");
  expect(loggedData.userId).toBe("operator");
  expect(loggedData.ok).toBe(true);
  expect(loggedData.authMethod).toBe("none");
  expect(loggedData.ip).toBe("1.2.3.4");
  expect(loggedData.scope).toBe("dovecote:notify");
  expect(typeof loggedData.ts).toBe("number");

  // Assert waitUntil called once
  expect(promises.length).toBe(1);

  // Assert KV put called with correct key pattern and TTL
  expect(kvPutSpy).toHaveBeenCalledTimes(1);

  const kvCall = kvPutSpy.mock.calls[0]!;
  const key = kvCall[0] as string;
  const value = kvCall[1] as string;
  const options = kvCall[2] as { expirationTtl?: number } | undefined;

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
    HMAC_PEPPER: "test-pepper",
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
      authMethod: "none",
      ip: "1.2.3.4",
      scope: "dovecote:notify",
    });
  }).not.toThrow();

  // Wait for promises to settle (should absorb error)
  await Promise.allSettled(promises);

  // Console log should still have happened
  expect(consoleLogSpy).toHaveBeenCalledTimes(1);

  consoleLogSpy.mockRestore();
});

test("writeAudit sanitizes free-text fields (reason with newline)", async () => {
  const mockKV = new MockKV();
  const promises: Promise<any>[] = [];

  const env: Env = {
    OAUTH_KV: mockKV as any,
    HMAC_PEPPER: "test-pepper",
  };

  const ctx = {
    waitUntil: (p: Promise<any>) => {
      promises.push(p);
    },
    passThroughOnException: () => {},
  } as any;

  const consoleLogSpy = spyOn(console, "log");

  // Call writeAudit with a reason containing a literal newline
  writeAudit(env, ctx, {
    event: "authorize",
    userId: "operator",
    ok: false,
    reason: "line1\nline2",
    authMethod: "none",
    ip: "1.2.3.4",
    scope: "dovecote:notify",
  });

  // Wait for promises
  await Promise.all(promises);

  // Get the logged JSON - use the last call which is this test's event
  const loggedString = consoleLogSpy.mock.calls[consoleLogSpy.mock.calls.length - 1]![0] as string;
  const parsed = JSON.parse(loggedString);

  // The reason should have the newline escaped as \n (not a literal newline)
  expect(parsed.reason).toBe("line1\\nline2");
  // Verify no literal newline in the raw logged string
  expect(parsed.reason.includes("\n")).toBe(false);

  consoleLogSpy.mockRestore();
});

test("writeAudit sanitizes reason with ANSI escape codes", async () => {
  const mockKV = new MockKV();
  const promises: Promise<any>[] = [];

  const env: Env = {
    OAUTH_KV: mockKV as any,
    HMAC_PEPPER: "test-pepper",
  };

  const ctx = {
    waitUntil: (p: Promise<any>) => {
      promises.push(p);
    },
    passThroughOnException: () => {},
  } as any;

  const consoleLogSpy = spyOn(console, "log");

  // Call writeAudit with a reason containing ESC character
  const reasonWithEsc = "red\x1B[31m";
  writeAudit(env, ctx, {
    event: "authorize",
    userId: "operator",
    ok: false,
    reason: reasonWithEsc,
    authMethod: "none",
    ip: "1.2.3.4",
    scope: "dovecote:notify",
  });

  // Wait for promises
  await Promise.all(promises);

  // Get the logged JSON - use the last call which is this test's event
  const loggedString = consoleLogSpy.mock.calls[consoleLogSpy.mock.calls.length - 1]![0] as string;
  const parsed = JSON.parse(loggedString);

  // The ESC should be escaped as \u001b - it appears in the middle of the string
  expect(parsed.reason).toBe("red\\u001b[31m");

  consoleLogSpy.mockRestore();
});

test("writeAudit sanitizes channel field with newline", async () => {
  const mockKV = new MockKV();
  const promises: Promise<any>[] = [];

  const env: Env = {
    OAUTH_KV: mockKV as any,
    HMAC_PEPPER: "test-pepper",
  };

  const ctx = {
    waitUntil: (p: Promise<any>) => {
      promises.push(p);
    },
    passThroughOnException: () => {},
  } as any;

  const consoleLogSpy = spyOn(console, "log");

  // Call writeAudit with a channel containing a literal newline
  writeAudit(env, ctx, {
    event: "notify.send",
    userId: "operator",
    channel: "chan-1\nfoo",
    ok: true,
    authMethod: "none",
    ip: "1.2.3.4",
    scope: "dovecote:notify",
  });

  // Wait for promises
  await Promise.all(promises);

  // Get the logged JSON - use the last call which is this test's event
  const loggedString = consoleLogSpy.mock.calls[consoleLogSpy.mock.calls.length - 1]![0] as string;
  const parsed = JSON.parse(loggedString);

  // The channel should have the newline escaped as \n
  expect(parsed.channel).toBe("chan-1\\nfoo");

  consoleLogSpy.mockRestore();
});

test("writeAudit does not sanitize userId (structured field, not free-text)", async () => {
  const mockKV = new MockKV();
  const promises: Promise<any>[] = [];

  const env: Env = {
    OAUTH_KV: mockKV as any,
    HMAC_PEPPER: "test-pepper",
  };

  const ctx = {
    waitUntil: (p: Promise<any>) => {
      promises.push(p);
    },
    passThroughOnException: () => {},
  } as any;

  const consoleLogSpy = spyOn(console, "log");

  // Call writeAudit with a userId containing a newline (edge case)
  writeAudit(env, ctx, {
    event: "authorize",
    userId: "user\nid",
    ok: true,
    authMethod: "none",
    ip: "1.2.3.4",
    scope: "dovecote:notify",
  });

  // Wait for promises
  await Promise.all(promises);

  // Get the logged JSON - use the last call which is this test's event
  const loggedString = consoleLogSpy.mock.calls[consoleLogSpy.mock.calls.length - 1]![0] as string;
  const parsed = JSON.parse(loggedString);

  // userId is NOT sanitized (it's a structured field, not in FREE_TEXT_FIELDS)
  // This is intentional - extractAuth already validates userId format
  expect(parsed.userId).toBe("user\nid");

  consoleLogSpy.mockRestore();
});

test("C-Schema-Audit-List: token.list ok writes count + truncated", async () => {
  const mockKV = new MockKV();
  const promises: Promise<any>[] = [];
  const env: Env = {
    OAUTH_KV: mockKV as any,
    HMAC_PEPPER: "p",
  };
  const ctx = {
    waitUntil: (p: Promise<any>) => promises.push(p),
    passThroughOnException: () => {},
  } as any;
  const consoleLogSpy = spyOn(console, "log");

  writeAudit(env, ctx, {
    event: "token.list",
    ok: true,
    count: 3,
    truncated: false,
    authMethod: "api_token",
    ip: "1.2.3.4",
    scope: "dovecote:notify",
  });

  await Promise.all(promises);
  const last = consoleLogSpy.mock.calls[consoleLogSpy.mock.calls.length - 1]![0] as string;
  expect(last).toContain('"event":"token.list"');
  expect(last).toContain('"count":3');
  expect(last).toContain('"truncated":false');
  consoleLogSpy.mockRestore();
});

test("C-Schema-Audit-List: token.list forbidden records userIdFilter + reason", async () => {
  const mockKV = new MockKV();
  const promises: Promise<any>[] = [];
  const env: Env = {
    OAUTH_KV: mockKV as any,
    HMAC_PEPPER: "p",
  };
  const ctx = {
    waitUntil: (p: Promise<any>) => promises.push(p),
    passThroughOnException: () => {},
  } as any;
  const consoleLogSpy = spyOn(console, "log");

  writeAudit(env, ctx, {
    event: "token.list",
    ok: false,
    reason: "forbidden",
    userIdFilter: "bob",
    authMethod: "api_token",
    ip: "1.2.3.4",
    scope: "dovecote:notify",
  });

  await Promise.all(promises);
  const last = consoleLogSpy.mock.calls[consoleLogSpy.mock.calls.length - 1]![0] as string;
  expect(last).toContain('"reason":"forbidden"');
  expect(last).toContain('"userIdFilter":"bob"');
  consoleLogSpy.mockRestore();
});
