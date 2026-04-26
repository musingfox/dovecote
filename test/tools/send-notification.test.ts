import { test, expect, mock, beforeEach } from "bun:test";
import { registerSendNotificationTool } from "../../src/tools/send-notification.js";
import type { Env } from "../../src/types.js";
import type { AuthCtx } from "../../src/auth/ctx.js";
import { createMockExecutionCtx } from "../helpers/mock-execution-ctx.js";
import { MockKV } from "../helpers/mock-kv.js";

function buildEnvWithDiscord(webhookUrl: string): Env {
  const kv = new MockKV();
  return {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "test",
    COOKIE_ENCRYPTION_KEY: "test",
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
  const auth: AuthCtx = { userId: "user-1", scopes: ["dovecote:notify"] };
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
