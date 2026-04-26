import { test, expect, mock } from "bun:test";
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

function captureHandler(env: Env): () => Promise<any> {
  let capturedHandler: any = null;
  const mockServer = {
    tool: mock((_name: string, _description: string, _schema: any, handler: any) => {
      capturedHandler = handler;
    }),
  };
  const auth: AuthCtx = { userId: "user-1", scopes: ["dovecote:notify"] };
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
