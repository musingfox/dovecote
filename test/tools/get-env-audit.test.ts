import { test, expect, mock } from "bun:test";
import type { Env } from "../../src/types.js";
import type { AuthCtx } from "../../src/auth/ctx.js";
import { registerGetEnvTool } from "../../src/tools/get-env.js";
import { MockKV } from "../helpers/mock-kv.js";
import { createMockExecutionCtx } from "../helpers/mock-execution-ctx.js";

test("get_env with valid scope logs env.read audit event with ok:true", async () => {
  const kv = new MockKV();
  await kv.put("env:prod", "FOO=bar");

  const env: Env = {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "test",
    COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length-required",
  };

  const auth: AuthCtx = {
    userId: "user-123",
    scopes: ["dovecote:env:read"],
  };

  const ctx = createMockExecutionCtx();

  let capturedHandler: any = null;
  const mockServer = {
    tool: mock((name: string, description: string, schema: any, handler: any) => {
      capturedHandler = handler;
    }),
  };

  registerGetEnvTool(mockServer as any, env, auth, ctx as any);

  // Call the tool handler
  const result = await capturedHandler({ profile: "prod" });

  // Wait for all audit promises to resolve
  await Promise.all(ctx._promises);

  // Verify tool returned success
  expect(result.isError).toBeUndefined();
  expect(result.content[0]).toEqual({
    type: "text",
    text: "FOO=bar",
  });

  // Verify audit event was written to KV
  const auditKeys = await kv.list({ prefix: "audit:" });
  expect(auditKeys.keys.length).toBe(1);

  const auditEntry = await kv.get(auditKeys.keys[0].name, { type: "json" });
  expect(auditEntry).toMatchObject({
    event: "env.read",
    userId: "user-123",
    profile: "prod",
    ok: true,
  });
  expect(auditEntry.ts).toBeTypeOf("number");
});

test("get_env without scope logs env.read audit event with ok:false", async () => {
  const kv = new MockKV();
  await kv.put("env:prod", "FOO=bar");

  const env: Env = {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "test",
    COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length-required",
  };

  const auth: AuthCtx = {
    userId: "user-456",
    scopes: [],
  };

  const ctx = createMockExecutionCtx();

  let capturedHandler: any = null;
  const mockServer = {
    tool: mock((name: string, description: string, schema: any, handler: any) => {
      capturedHandler = handler;
    }),
  };

  registerGetEnvTool(mockServer as any, env, auth, ctx as any);

  // Call the tool handler
  const result = await capturedHandler({ profile: "prod" });

  // Wait for all audit promises to resolve
  await Promise.all(ctx._promises);

  // Verify tool returned error
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("Forbidden");

  // Verify audit event was written to KV
  const auditKeys = await kv.list({ prefix: "audit:" });
  expect(auditKeys.keys.length).toBe(1);

  const auditEntry = await kv.get(auditKeys.keys[0].name, { type: "json" });
  expect(auditEntry).toMatchObject({
    event: "env.read",
    userId: "user-456",
    profile: "prod",
    ok: false,
  });
  expect(auditEntry.ts).toBeTypeOf("number");
});

test("get_env for nonexistent profile logs env.read audit event with ok:false", async () => {
  const kv = new MockKV();

  const env: Env = {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "test",
    COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length-required",
  };

  const auth: AuthCtx = {
    userId: "user-789",
    scopes: ["dovecote:env:read"],
  };

  const ctx = createMockExecutionCtx();

  let capturedHandler: any = null;
  const mockServer = {
    tool: mock((name: string, description: string, schema: any, handler: any) => {
      capturedHandler = handler;
    }),
  };

  registerGetEnvTool(mockServer as any, env, auth, ctx as any);

  // Call the tool handler
  const result = await capturedHandler({ profile: "nonexistent" });

  // Wait for all audit promises to resolve
  await Promise.all(ctx._promises);

  // Verify tool returned error
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("not found");

  // Verify audit event was written to KV
  const auditKeys = await kv.list({ prefix: "audit:" });
  expect(auditKeys.keys.length).toBe(1);

  const auditEntry = await kv.get(auditKeys.keys[0].name, { type: "json" });
  expect(auditEntry).toMatchObject({
    event: "env.read",
    userId: "user-789",
    profile: "nonexistent",
    ok: false,
  });
  expect(auditEntry.ts).toBeTypeOf("number");
});
