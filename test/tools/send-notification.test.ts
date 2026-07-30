import { test, expect, mock, spyOn, beforeEach } from "bun:test";
import { registerSendNotificationTool } from "../../src/tools/send-notification.js";
import type { Env } from "../../src/types.js";
import type { AuthCtx } from "../../src/auth/ctx.js";
import { createMockExecutionCtx } from "../helpers/mock-execution-ctx.js";
import { MockKV } from "../helpers/mock-kv.js";

function buildEnvWithDiscord(webhookUrl: string): Env {
  const kv = new MockKV();
  return {
    OAUTH_KV: kv as any,
    HMAC_PEPPER: "test-pepper",
    DISCORD_INSTANCES: JSON.stringify([{ id: "main", webhookUrl }]),
  };
}

function captureHandler(env: Env): (args: any) => Promise<any> {
  let capturedHandler: any = null;
  const mockServer = {
    tool: mock((_name: string, _description: string, _schema: any, handler: any) => {
      capturedHandler = handler;
    }),
  };
  const auth: AuthCtx = { userId: "user-1", scopes: ["dovecote:notify"], authMethod: "oauth", ip: "unknown" };
  const ctx = createMockExecutionCtx(auth) as any;
  registerSendNotificationTool(mockServer as any, env, auth, ctx);
  if (!capturedHandler) throw new Error("handler was not captured");
  return capturedHandler;
}

beforeEach(() => {
  mock.restore();
});

test("send_notification: discord 200 → handler resolves, fetch called with content", async () => {
  const webhookUrl = "https://discord.com/api/webhooks/123/abc";
  const env = buildEnvWithDiscord(webhookUrl);

  let capturedBody: string | undefined;
  const mockFetch = mock((_url: string, options?: any) => {
    capturedBody = options?.body;
    return Promise.resolve(
      new Response(
        JSON.stringify({ id: "msg-999", content: "hello", channel_id: "ch-1" }),
        { status: 200 }
      )
    );
  });
  globalThis.fetch = mockFetch as any;

  const handler = captureHandler(env);
  const result = await handler({ channel: "discord-main", content: { text: "hello" } });

  // handler resolves without error
  expect(result.isError).toBeUndefined();

  // fetch was called exactly once
  expect(mockFetch.mock.calls.length).toBe(1);

  // body contains "hello"
  expect(capturedBody).toBeDefined();
  const body = JSON.parse(capturedBody!);
  expect(body.content).toBe("hello");
});

test("send_notification: SSRF URL rejected at config time → handler returns error, fetch not called", async () => {
  // A malicious URL that would be an SSRF target.
  // isValidDiscordWebhookUrl rejects non-discord.com URLs, so the channel won't be registered.
  const ssrfUrl = "https://169.254.169.254/api/webhooks/123/abc";
  const env = buildEnvWithDiscord(ssrfUrl);

  const mockFetch = mock(() => {
    return Promise.resolve(new Response("should not be called", { status: 200 }));
  });
  globalThis.fetch = mockFetch as any;

  const handler = captureHandler(env);
  // The channel "discord-main" was never registered because the URL failed validation
  const result = await handler({ channel: "discord-main", content: { text: "hello" } });

  // handler returns an error
  expect(result.isError).toBe(true);

  // fetch was never called
  expect(mockFetch.mock.calls.length).toBe(0);
});

// ============================================================
// C1: scope-fail rejection with audit
// ============================================================

function buildNoScopeHandler(auth: AuthCtx): (args: any) => Promise<any> {
  const kv = new MockKV();
  const env: Env = {
    OAUTH_KV: kv as any,
    HMAC_PEPPER: "test-pepper",
  };
  const ctx = createMockExecutionCtx(auth) as any;
  let capturedHandler: any = null;
  const mockServer = {
    tool: mock((_name: string, _description: string, _schema: any, handler: any) => {
      capturedHandler = handler;
    }),
  };
  registerSendNotificationTool(mockServer as any, env, auth, ctx);
  if (!capturedHandler) throw new Error("handler was not captured");
  return capturedHandler;
}

test("C1: send_notification forbidden (user-A, scopes=[], discord-test) → isError + audit", async () => {
  const auth: AuthCtx = { userId: "user-A", scopes: [], authMethod: "oauth", ip: "unknown" };
  const consoleLogSpy = spyOn(console, "log");

  const handler = buildNoScopeHandler(auth);
  const result = await handler({ channel: "discord-test", content: { text: "hi" } });

  expect(result.isError).toBe(true);
  expect(result.content[0].text).toBe("Forbidden: missing scope dovecote:notify");

  const logCalls = consoleLogSpy.mock.calls
    .filter((call) => { try { JSON.parse(call[0]); return true; } catch { return false; } })
    .map((call) => JSON.parse(call[0]));
  const auditLog = logCalls.find((log: any) => log.event === "notify.send");

  expect(auditLog).toBeDefined();
  expect(auditLog.userId).toBe("user-A");
  expect(auditLog.channel).toBe("discord-test");
  expect(auditLog.ok).toBe(false);
  expect(auditLog.reason).toBe("forbidden");

  consoleLogSpy.mockRestore();
});

test("C1: send_notification forbidden (user-B, scopes=[dovecote:admin], telegram-test) → isError + audit", async () => {
  const auth: AuthCtx = { userId: "user-B", scopes: ["dovecote:admin"], authMethod: "oauth", ip: "unknown" };
  const consoleLogSpy = spyOn(console, "log");

  const handler = buildNoScopeHandler(auth);
  const result = await handler({ channel: "telegram-test", content: { text: "x" } });

  expect(result.isError).toBe(true);
  expect(result.content[0].text).toBe("Forbidden: missing scope dovecote:notify");

  const logCalls = consoleLogSpy.mock.calls
    .filter((call) => { try { JSON.parse(call[0]); return true; } catch { return false; } })
    .map((call) => JSON.parse(call[0]));
  const auditLog = logCalls.find((log: any) => log.event === "notify.send");

  expect(auditLog).toBeDefined();
  expect(auditLog.userId).toBe("user-B");
  expect(auditLog.channel).toBe("telegram-test");
  expect(auditLog.ok).toBe(false);
  expect(auditLog.reason).toBe("forbidden");

  consoleLogSpy.mockRestore();
});

// ============================================================
// C7: channel length clamp at 256 characters in audit
// ============================================================

test("C7: send_notification forbidden with >256 char channel → audit channel clamped to 256", async () => {
  const auth: AuthCtx = { userId: "user-C7", scopes: [], authMethod: "oauth", ip: "unknown" };
  const consoleLogSpy = spyOn(console, "log");

  const handler = buildNoScopeHandler(auth);
  const longChannel = "x".repeat(300);
  const result = await handler({ channel: longChannel, content: { text: "hi" } });

  expect(result.isError).toBe(true);
  expect(result.content[0].text).toBe("Forbidden: missing scope dovecote:notify");

  const logCalls = consoleLogSpy.mock.calls
    .filter((call) => { try { JSON.parse(call[0]); return true; } catch { return false; } })
    .map((call) => JSON.parse(call[0]));
  const auditLog = logCalls.find((log: any) => log.event === "notify.send");

  expect(auditLog).toBeDefined();
  expect(auditLog.channel).toBe(longChannel.slice(0, 256));
  expect(auditLog.channel.length).toBe(256);

  consoleLogSpy.mockRestore();
});

// ============================================================
// C2: scope-pass behavior unchanged — no notify.send audit
// ============================================================

test("C2: send_notification scope-pass, unknown channel → isError but no notify.send audit", async () => {
  // Env with no channel configuration so any channel is unknown
  const kv = new MockKV();
  const env: Env = {
    OAUTH_KV: kv as any,
    HMAC_PEPPER: "test-pepper",
  };
  const auth: AuthCtx = { userId: "user-pass", scopes: ["dovecote:notify"], authMethod: "oauth", ip: "unknown" };
  const ctx = createMockExecutionCtx(auth) as any;

  const consoleLogSpy = spyOn(console, "log");

  let capturedHandler: any = null;
  const mockServer = {
    tool: mock((_name: string, _description: string, _schema: any, handler: any) => {
      capturedHandler = handler;
    }),
  };
  registerSendNotificationTool(mockServer as any, env, auth, ctx);

  const result = await capturedHandler({ channel: "discord-x", content: { text: "hello" } });

  // Should fail but NOT due to scope guard — due to unknown channel
  expect(result.isError).toBe(true);
  const text: string = result.content[0].text;
  expect(text.includes("Failed to send") || text.includes("Unknown channel")).toBe(true);
  // Must NOT be the scope-guard message
  expect(text).not.toBe("Forbidden: missing scope dovecote:notify");

  // Must NOT have any notify.send audit
  const logCalls = consoleLogSpy.mock.calls
    .filter((call) => { try { JSON.parse(call[0]); return true; } catch { return false; } })
    .map((call) => JSON.parse(call[0]));
  const auditLog = logCalls.find((log: any) => log.event === "notify.send");
  expect(auditLog).toBeUndefined();

  consoleLogSpy.mockRestore();
});

test("C2: send_notification scope-pass with stub channel → success, no notify.send audit", async () => {
  // Use a real Discord channel in env and mock globalThis.fetch to return success
  const webhookUrl = "https://discord.com/api/webhooks/999/stubtoken";
  const kv = new MockKV();
  const env: Env = {
    OAUTH_KV: kv as any,
    HMAC_PEPPER: "test-pepper",
    DISCORD_INSTANCES: JSON.stringify([{ id: "stub", webhookUrl }]),
  };
  const auth: AuthCtx = { userId: "user-stub", scopes: ["dovecote:notify"], authMethod: "oauth", ip: "unknown" };
  const ctx = createMockExecutionCtx(auth) as any;

  // Mock fetch to return a Discord-like success response
  const mockFetch = mock((_url: string, _options?: any) => {
    return Promise.resolve(
      new Response(
        JSON.stringify({ id: "msg-999", content: "hello stub", channel_id: "ch-1" }),
        { status: 200 }
      )
    );
  });
  globalThis.fetch = mockFetch as any;

  const consoleLogSpy = spyOn(console, "log");

  let capturedHandler: any = null;
  const mockServer = {
    tool: mock((_name: string, _description: string, _schema: any, handler: any) => {
      capturedHandler = handler;
    }),
  };
  registerSendNotificationTool(mockServer as any, env, auth, ctx);

  const result = await capturedHandler({ channel: "discord-stub", content: { text: "hello stub" } });

  expect(result.isError).toBeUndefined();
  const parsed = JSON.parse(result.content[0].text);
  expect(parsed.channel).toBe("discord-stub");
  expect(parsed.messageId).toBeDefined();

  // Must NOT have any notify.send audit
  const logCalls = consoleLogSpy.mock.calls
    .filter((call) => { try { JSON.parse(call[0]); return true; } catch { return false; } })
    .map((call) => JSON.parse(call[0]));
  const auditLog = logCalls.find((log: any) => log.event === "notify.send");
  expect(auditLog).toBeUndefined();

  consoleLogSpy.mockRestore();
});
