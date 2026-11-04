import { test, expect, mock, afterEach } from "bun:test";
import app from "../src/index.js";
import { issueToken } from "../src/auth/api-token.js";
import type { Env } from "../src/types.js";
import { MockKV } from "./helpers/mock-kv.js";
import { createMockExecutionCtx } from "./helpers/mock-execution-ctx.js";
import { runFormOAuthFlow } from "./helpers/form-oauth.js";

// Every send through REST /v1/notify and MCP send_notification leaves exactly
// one notify.send naming the dvct token behind it, driven through the real app.

const BASE = "https://example.com";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const LABEL = "ci-runner";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function makeEnv(): Promise<Env> {
  const kv = new MockKV();
  await kv.put(
    "channel:discord-main",
    JSON.stringify({ service: "discord", id: "main", webhookUrl: "https://discord.com/api/webhooks/123/abc" }),
  );
  return {
    OAUTH_KV: kv as any,
    HMAC_PEPPER: "test-pepper",
    ADMIN_REVOKE_TOKEN: "admin-token-123",
    ENABLE_CLIENT_BOOTSTRAP: "1",
  };
}

function discordAnswers(status: number) {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ id: "msg-1", channel_id: "ch-1" }), { status })),
  ) as any;
}

/** Run one request through the app and wait for its audit writes. */
async function run(env: Env, req: Request): Promise<Response> {
  const ctx = createMockExecutionCtx();
  const res = await app.fetch(req, env, ctx as any);
  await res.text();
  await Promise.all(ctx._promises);
  return res;
}

async function notifySends(env: Env): Promise<any[]> {
  const kv = env.OAUTH_KV as unknown as MockKV;
  const listed = await kv.list({ prefix: "audit:" });
  const entries = await Promise.all(listed.keys.map(({ name }) => kv.get(name, "json")));
  return entries.filter((e: any) => e.event === "notify.send");
}

type Sender = (env: Env, body: string) => Promise<{ tokenId: string; authMethod: string }>;

const viaRest: Sender = async (env, body) => {
  const { token, tokenId } = await issueToken({ userId: "alice", scopes: ["dovecote:notify"], label: LABEL }, env);
  await run(
    env,
    new Request(`${BASE}/v1/notify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body,
    }),
  );
  return { tokenId, authMethod: "api_token" };
};

const viaMcp: Sender = async (env, body) => {
  const doFetch = (req: Request) => Promise.resolve(app.fetch(req, env, createMockExecutionCtx() as any));
  const res = await doFetch(
    new Request(`${BASE}/admin/bootstrap-client`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer admin-token-123" },
      body: JSON.stringify({ clientName: "c", redirectUris: [REDIRECT_URI] }),
    }),
  );
  const clientId = ((await res.json()) as { client_id: string }).client_id;
  const { accessToken, tokenId } = await runFormOAuthFlow({
    doFetch,
    env,
    clientId,
    redirectUri: REDIRECT_URI,
    scope: "dovecote:notify",
    state: "s",
    userId: "alice",
    label: LABEL,
    baseUrl: BASE,
  });
  const { channel, content } = JSON.parse(body);
  await run(
    env,
    new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "send_notification", arguments: { channel, content } },
      }),
    }),
  );
  return { tokenId, authMethod: "api_token" };
};

const cases: Array<{ name: string; channel: string; discordStatus: number; ok: boolean; reason?: string }> = [
  { name: "a delivered send", channel: "discord-main", discordStatus: 200, ok: true },
  { name: "an unknown channel", channel: "discord-nope", discordStatus: 200, ok: false, reason: "unknown_channel" },
  { name: "an upstream error", channel: "discord-main", discordStatus: 500, ok: false, reason: "upstream_error" },
];

for (const [path, send] of [["REST /v1/notify", viaRest], ["MCP send_notification", viaMcp]] as const) {
  for (const c of cases) {
    test(`${path}: ${c.name} writes one notify.send ok:${c.ok} with tokenId, label and channel`, async () => {
      const env = await makeEnv();
      discordAnswers(c.discordStatus);
      const { tokenId, authMethod } = await send(
        env,
        JSON.stringify({ channel: c.channel, content: { text: "hi" } }),
      );
      const audits = await notifySends(env);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        ok: c.ok,
        userId: "alice",
        tokenId,
        authMethod,
        label: LABEL,
        channel: c.channel,
      });
      expect(audits[0].reason).toBe(c.reason);
    });
  }
}

test("REST /v1/notify: a body that fails validation writes notify.send ok:false with tokenId", async () => {
  const env = await makeEnv();
  const { tokenId } = await viaRest(env, JSON.stringify({ channel: "discord-main", content: {} }));
  const audits = await notifySends(env);
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ ok: false, reason: "invalid_request", tokenId, label: LABEL });
});

test("REST /v1/notify: a channel that is not a string writes notify.send ok:false invalid_request", async () => {
  const env = await makeEnv();
  const { tokenId } = await viaRest(env, JSON.stringify({ channel: 3, content: { text: "hi" } }));
  const audits = await notifySends(env);
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ ok: false, reason: "invalid_request", tokenId, label: LABEL });
  expect(audits[0].channel).toBeUndefined();
});

// The channel adapters turn delivery failures into success:false, so the
// internal_error path is reached by the channel lookup itself throwing.
test("MCP send_notification: a send that throws writes one notify.send ok:false internal_error", async () => {
  const env = await makeEnv();
  const kv = env.OAUTH_KV as unknown as MockKV;
  const get = kv.get.bind(kv);
  kv.get = ((key: string, options?: any) =>
    key.startsWith("channel:") ? Promise.reject(new Error("KV unavailable")) : get(key, options)) as typeof kv.get;
  const { tokenId } = await viaMcp(env, JSON.stringify({ channel: "discord-main", content: { text: "hi" } }));
  const audits = await notifySends(env);
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    ok: false,
    reason: "internal_error",
    tokenId,
    label: LABEL,
    channel: "discord-main",
  });
});

test("REST /v1/notify: an unparseable body writes notify.send ok:false with tokenId", async () => {
  const env = await makeEnv();
  const { tokenId } = await viaRest(env, "{");
  const audits = await notifySends(env);
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ ok: false, reason: "invalid_json", tokenId, label: LABEL });
});
