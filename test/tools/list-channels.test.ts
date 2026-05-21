import { test, expect, mock, spyOn } from "bun:test";
import { registerListChannelsTool } from "../../src/tools/list-channels.js";
import type { Env } from "../../src/types.js";
import type { AuthCtx } from "../../src/auth/ctx.js";
import { createMockExecutionCtx } from "../helpers/mock-execution-ctx.js";
import { MockKV } from "../helpers/mock-kv.js";

function buildEnvWithChannels(): Env {
  const kv = new MockKV();
  return {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "test",
    COOKIE_ENCRYPTION_KEY: "test",
    DISCORD_INSTANCES: JSON.stringify([
      { id: "main", webhookUrl: "https://discord.com/api/webhooks/123/abc" },
    ]),
    TELEGRAM_INSTANCES: JSON.stringify([
      { id: "main", botToken: "bot123:token", chatId: "-100123456" },
    ]),
  };
}

function captureHandler(env: Env): (args?: unknown) => Promise<any> {
  let capturedHandler: any = null;
  const mockServer = {
    tool: mock((_name: string, _description: string, _schema: any, handler: any) => {
      capturedHandler = handler;
    }),
  };
  const auth: AuthCtx = { userId: "user-1", scopes: ["dovecote:notify"], authMethod: "oauth", ip: "unknown" };
  const ctx = createMockExecutionCtx(auth) as any;
  registerListChannelsTool(mockServer as any, env, auth, ctx);
  if (!capturedHandler) throw new Error("handler was not captured");
  return capturedHandler;
}

test("list_channels: returns array with at least discord and telegram entries", async () => {
  const env = buildEnvWithChannels();
  const handler = captureHandler(env);

  const result = await handler({});

  expect(result.isError).toBeUndefined();
  expect(result.content).toBeDefined();
  expect(result.content.length).toBeGreaterThan(0);

  const text: string = result.content[0].text;
  const channels: Array<{ id: string }> = JSON.parse(text);

  expect(Array.isArray(channels)).toBe(true);

  const ids = channels.map((c) => c.id);

  // must include a discord channel
  const hasDiscord = ids.some((id) => id.startsWith("discord"));
  expect(hasDiscord).toBe(true);

  // must include a telegram channel
  const hasTelegram = ids.some((id) => id.startsWith("telegram"));
  expect(hasTelegram).toBe(true);
});

test("list_channels: each channel entry has id, name, enabled, service fields", async () => {
  const env = buildEnvWithChannels();
  const handler = captureHandler(env);

  const result = await handler({});

  const channels: Array<Record<string, unknown>> = JSON.parse(result.content[0].text);

  for (const channel of channels) {
    expect(typeof channel["id"]).toBe("string");
    expect(typeof channel["name"]).toBe("string");
    expect(typeof channel["enabled"]).toBe("boolean");
    expect(typeof channel["service"]).toBe("string");
  }
});

test("list_channels: empty env returns empty array", async () => {
  const kv = new MockKV();
  const env: Env = {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "test",
    COOKIE_ENCRYPTION_KEY: "test",
  };
  const handler = captureHandler(env);

  const result = await handler({});

  const channels = JSON.parse(result.content[0].text);
  expect(Array.isArray(channels)).toBe(true);
  expect(channels.length).toBe(0);
});

// ============================================================
// C3: list_channels scope-fail rejection without audit
// ============================================================

test("C3: list_channels forbidden (user-C, scopes=[]) → isError, no notify.* audit", async () => {
  const kv = new MockKV();
  const env: Env = {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "test",
    COOKIE_ENCRYPTION_KEY: "test",
    DISCORD_INSTANCES: JSON.stringify([{ id: "test", webhookUrl: "https://discord.com/api/webhooks/1/abc" }]),
    TELEGRAM_INSTANCES: JSON.stringify([{ id: "test", botToken: "bot:token", chatId: "123" }]),
  };
  const auth: AuthCtx = { userId: "user-C", scopes: [], authMethod: "oauth", ip: "unknown" };
  const ctx = createMockExecutionCtx(auth) as any;

  const consoleLogSpy = spyOn(console, "log");

  let capturedHandler: any = null;
  const mockServer = {
    tool: mock((_name: string, _description: string, _schema: any, handler: any) => {
      capturedHandler = handler;
    }),
  };
  registerListChannelsTool(mockServer as any, env, auth, ctx);

  const result = await capturedHandler({});

  expect(result.isError).toBe(true);
  expect(result.content[0].text).toBe("Forbidden: missing scope dovecote:notify");

  // Must NOT have any notify.* audit
  const logCalls = consoleLogSpy.mock.calls
    .filter((call) => { try { JSON.parse(call[0]); return true; } catch { return false; } })
    .map((call) => JSON.parse(call[0]));
  const notifyAudit = logCalls.find((log: any) => typeof log.event === "string" && log.event.startsWith("notify."));
  expect(notifyAudit).toBeUndefined();

  consoleLogSpy.mockRestore();
});

// ============================================================
// C4: list_channels scope-pass behavior unchanged
// ============================================================

test("C4: list_channels scope-pass with discord stub → isError undefined, length=1, id=discord-test", async () => {
  const kv = new MockKV();
  const env: Env = {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "test",
    COOKIE_ENCRYPTION_KEY: "test",
    DISCORD_INSTANCES: JSON.stringify([{ id: "test", webhookUrl: "https://discord.com/api/webhooks/1/abc" }]),
  };
  const auth: AuthCtx = { userId: "user-pass", scopes: ["dovecote:notify"], authMethod: "oauth", ip: "unknown" };
  const ctx = createMockExecutionCtx(auth) as any;

  let capturedHandler: any = null;
  const mockServer = {
    tool: mock((_name: string, _description: string, _schema: any, handler: any) => {
      capturedHandler = handler;
    }),
  };
  registerListChannelsTool(mockServer as any, env, auth, ctx);

  const result = await capturedHandler({});

  expect(result.isError).toBeUndefined();
  const channels = JSON.parse(result.content[0].text);
  expect(channels).toHaveLength(1);
  expect(channels[0].id).toBe("discord-test");
});
