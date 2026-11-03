import { test, expect, mock, afterEach } from "bun:test";
import apiApp, { MCP_MAX_REQUEST_BODY_SIZE } from "../src/api.js";
import { ATTACHMENT_DATA_MAX } from "../src/contracts/notifications.js";
import type { Env } from "../src/types.js";
import { createMockExecutionCtx } from "./helpers/mock-execution-ctx";
import { MockKV } from "./helpers/mock-kv.js";

// Request-size guards on /mcp for GHSA-f897-62hf-6gxq and GHSA-46jr-4wx8-v453,
// exercised through the real Hono route and SDK transport.

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function envWithDiscordChannel(): Promise<Env> {
  const kv = new MockKV();
  await kv.put(
    "channel:discord-main",
    JSON.stringify({ service: "discord", id: "main", webhookUrl: "https://discord.com/api/webhooks/123/abc" })
  );
  return { OAUTH_KV: kv as any, HMAC_PEPPER: "test-pepper" };
}

function mockDiscordOk() {
  const fetchMock = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ id: "msg-1", channel_id: "ch-1" }), { status: 200 }))
  );
  globalThis.fetch = fetchMock as any;
  return fetchMock;
}

async function postMcp(env: Env, body: string): Promise<Response> {
  const req = new Request("https://example.com/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body,
  });
  const ctx = createMockExecutionCtx({ userId: "operator", scopes: ["dovecote:notify"] });
  return apiApp.fetch(req, env, ctx as any);
}

function sendNotificationCall(content: unknown): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "send_notification", arguments: { channel: "discord-main", content } },
  });
}

async function readRpcResponse(res: Response): Promise<any> {
  const text = await res.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(dataLine ? dataLine.slice("data: ".length) : text);
}

test("/mcp send_notification with a plain text message reaches the channel", async () => {
  const env = await envWithDiscordChannel();
  const fetchMock = mockDiscordOk();

  const res = await postMcp(env, sendNotificationCall({ text: "hello" }));

  expect(res.status).toBe(200);
  const rpc = await readRpcResponse(res);
  expect(rpc.result.isError).toBeUndefined();
  expect(JSON.parse(rpc.result.content[0].text).messageId).toBe("msg-1");
  expect(fetchMock.mock.calls.length).toBe(1);
});

test("/mcp accepts a send_notification carrying the largest attachment the schema allows", async () => {
  const env = await envWithDiscordChannel();
  const fetchMock = mockDiscordOk();
  const body = sendNotificationCall({
    attachment: { filename: "big.bin", data: "A".repeat(ATTACHMENT_DATA_MAX) },
  });
  expect(body.length).toBeLessThanOrEqual(MCP_MAX_REQUEST_BODY_SIZE);

  const res = await postMcp(env, body);

  expect(res.status).toBe(200);
  const rpc = await readRpcResponse(res);
  expect(rpc.result.isError).toBeUndefined();
  expect(fetchMock.mock.calls.length).toBe(1);
});

test("/mcp rejects a request body one byte over the limit with 413", async () => {
  const env = await envWithDiscordChannel();
  const fetchMock = mockDiscordOk();
  const envelope = sendNotificationCall({ text: "" });
  const padding = "x".repeat(MCP_MAX_REQUEST_BODY_SIZE + 1 - envelope.length);
  const body = sendNotificationCall({ text: padding });
  expect(body.length).toBe(MCP_MAX_REQUEST_BODY_SIZE + 1);

  const res = await postMcp(env, body);

  expect(res.status).toBe(413);
  expect(fetchMock.mock.calls.length).toBe(0);
});
