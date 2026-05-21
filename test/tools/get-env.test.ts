import { test, expect, spyOn, mock } from "bun:test";
import { registerGetEnvTool } from "../../src/tools/get-env.js";
import { MockKV } from "../helpers/mock-kv.js";
import { createMockExecutionCtx } from "../helpers/mock-execution-ctx.js";
import type { Env } from "../../src/types.js";
import type { AuthCtx } from "../../src/auth/ctx.js";

test("get_env forbidden when missing dovecote:env:read scope", async () => {
  const kv = new MockKV();
  const env: Env = {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "test",
    COOKIE_ENCRYPTION_KEY: "test",
  };
  const auth: AuthCtx = {
    userId: "user-123",
    scopes: ["dovecote:notify"],
    authMethod: "oauth",
    ip: "unknown",
  };
  const ctx = createMockExecutionCtx(auth) as any;

  const consoleLogSpy = spyOn(console, "log");

  let capturedHandler: any = null;
  const mockServer = {
    tool: mock((name: string, description: string, schema: any, handler: any) => {
      capturedHandler = handler;
    }),
  };

  registerGetEnvTool(mockServer as any, env, auth, ctx);

  const result = await capturedHandler({ profile: "production" });

  expect(result.isError).toBe(true);
  expect(result.content[0].text).toBe("Forbidden: missing scope dovecote:env:read");

  const logCalls = consoleLogSpy.mock.calls.map((call) => JSON.parse(call[0]));
  const auditLog = logCalls.find((log) => log.event === "env.read");

  expect(auditLog).toBeDefined();
  expect(auditLog.userId).toBe("user-123");
  expect(auditLog.profile).toBe("production");
  expect(auditLog.ok).toBe(false);

  consoleLogSpy.mockRestore();
});

test("get_env forbidden for anonymous user", async () => {
  const kv = new MockKV();
  const env: Env = {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "test",
    COOKIE_ENCRYPTION_KEY: "test",
  };
  const auth: AuthCtx = {
    userId: "anonymous",
    scopes: [],
    authMethod: "oauth",
    ip: "unknown",
  };
  const ctx = createMockExecutionCtx(auth) as any;

  const consoleLogSpy = spyOn(console, "log");

  let capturedHandler: any = null;
  const mockServer = {
    tool: mock((name: string, description: string, schema: any, handler: any) => {
      capturedHandler = handler;
    }),
  };

  registerGetEnvTool(mockServer as any, env, auth, ctx);

  const result = await capturedHandler({ profile: "production" });

  expect(result.isError).toBe(true);
  expect(result.content[0].text).toBe("Forbidden: missing scope dovecote:env:read");

  const logCalls = consoleLogSpy.mock.calls.map((call) => JSON.parse(call[0]));
  const auditLog = logCalls.find((log) => log.event === "env.read");

  expect(auditLog).toBeDefined();
  expect(auditLog.ok).toBe(false);

  consoleLogSpy.mockRestore();
});

test("get_env returns value when profile exists", async () => {
  const kv = new MockKV();
  await kv.put("env:prod", "KEY=val");

  const env: Env = {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "test",
    COOKIE_ENCRYPTION_KEY: "test",
  };
  const auth: AuthCtx = {
    userId: "user-456",
    scopes: ["dovecote:env:read"],
    authMethod: "oauth",
    ip: "unknown",
  };
  const ctx = createMockExecutionCtx(auth) as any;

  const consoleLogSpy = spyOn(console, "log");

  let capturedHandler: any = null;
  const mockServer = {
    tool: mock((name: string, description: string, schema: any, handler: any) => {
      capturedHandler = handler;
    }),
  };

  registerGetEnvTool(mockServer as any, env, auth, ctx);

  const result = await capturedHandler({ profile: "prod" });

  expect(result.isError).toBeUndefined();
  expect(result.content[0].text).toBe("KEY=val");

  const logCalls = consoleLogSpy.mock.calls.map((call) => JSON.parse(call[0]));
  const auditLog = logCalls.find((log) => log.event === "env.read");

  expect(auditLog).toBeDefined();
  expect(auditLog.userId).toBe("user-456");
  expect(auditLog.profile).toBe("prod");
  expect(auditLog.ok).toBe(true);

  consoleLogSpy.mockRestore();
});

test("get_env returns not found when profile does not exist", async () => {
  const kv = new MockKV();

  const env: Env = {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "test",
    COOKIE_ENCRYPTION_KEY: "test",
  };
  const auth: AuthCtx = {
    userId: "user-789",
    scopes: ["dovecote:env:read"],
    authMethod: "oauth",
    ip: "unknown",
  };
  const ctx = createMockExecutionCtx(auth) as any;

  const consoleLogSpy = spyOn(console, "log");

  let capturedHandler: any = null;
  const mockServer = {
    tool: mock((name: string, description: string, schema: any, handler: any) => {
      capturedHandler = handler;
    }),
  };

  registerGetEnvTool(mockServer as any, env, auth, ctx);

  const result = await capturedHandler({ profile: "staging" });

  expect(result.isError).toBe(true);
  expect(result.content[0].text).toBe('Profile "staging" not found');

  const logCalls = consoleLogSpy.mock.calls.map((call) => JSON.parse(call[0]));
  const auditLog = logCalls.find((log) => log.event === "env.read");

  expect(auditLog).toBeDefined();
  expect(auditLog.profile).toBe("staging");
  expect(auditLog.ok).toBe(false);

  consoleLogSpy.mockRestore();
});

test("get_env returns empty string when profile is empty", async () => {
  const kv = new MockKV();
  await kv.put("env:empty", "");

  const env: Env = {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "test",
    COOKIE_ENCRYPTION_KEY: "test",
  };
  const auth: AuthCtx = {
    userId: "user-empty",
    scopes: ["dovecote:env:read"],
    authMethod: "oauth",
    ip: "unknown",
  };
  const ctx = createMockExecutionCtx(auth) as any;

  const consoleLogSpy = spyOn(console, "log");

  let capturedHandler: any = null;
  const mockServer = {
    tool: mock((name: string, description: string, schema: any, handler: any) => {
      capturedHandler = handler;
    }),
  };

  registerGetEnvTool(mockServer as any, env, auth, ctx);

  const result = await capturedHandler({ profile: "empty" });

  expect(result.isError).toBeUndefined();
  expect(result.content[0].text).toBe("");

  const logCalls = consoleLogSpy.mock.calls.map((call) => JSON.parse(call[0]));
  const auditLog = logCalls.find((log) => log.event === "env.read");

  expect(auditLog).toBeDefined();
  expect(auditLog.ok).toBe(true);

  consoleLogSpy.mockRestore();
});

test("get_env schema rejects profile names that could cross KV prefix boundaries", async () => {
  const kv = new MockKV();
  const env: Env = {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "test",
    COOKIE_ENCRYPTION_KEY: "test",
  };
  const auth: AuthCtx = { userId: "u", scopes: ["dovecote:env:read"], authMethod: "oauth", ip: "unknown" };
  const ctx = createMockExecutionCtx(auth) as any;

  let capturedSchema: any = null;
  const mockServer = {
    tool: mock((_name: string, _desc: string, schema: any, _handler: any) => {
      capturedSchema = schema;
    }),
  };
  registerGetEnvTool(mockServer as any, env, auth, ctx);

  const { z } = await import("zod");
  const shape = z.object(capturedSchema);

  expect(shape.safeParse({ profile: "../audit:123" }).success).toBe(false);
  expect(shape.safeParse({ profile: "env\naudit:x" }).success).toBe(false);
  expect(shape.safeParse({ profile: "foo:token:x" }).success).toBe(false);
  expect(shape.safeParse({ profile: "foo bar" }).success).toBe(false);
  expect(shape.safeParse({ profile: "production" }).success).toBe(true);
  expect(shape.safeParse({ profile: "staging-1_test" }).success).toBe(true);
});
