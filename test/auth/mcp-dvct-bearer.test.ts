import { test, expect, mock, afterEach } from "bun:test";
import app from "../../src/index.js";
import { DEFAULT_TTL_SECONDS, KV_HASH_NAMESPACE, issueToken, revokeToken } from "../../src/auth/api-token.js";
import type { Env } from "../../src/types.js";
import { MockKV } from "../helpers/mock-kv.js";
import { createMockExecutionCtx } from "../helpers/mock-execution-ctx.js";
import { runFormOAuthFlow } from "../helpers/form-oauth.js";

// Headless MCP clients cannot run the OAuth dance, so /mcp also accepts the
// dvct token itself as the bearer, driven here through the real provider.

const BASE = "https://example.com";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const LABEL = "headless-ci";

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

async function run(env: Env, req: Request): Promise<{ res: Response; body: string }> {
  const ctx = createMockExecutionCtx();
  const res = await app.fetch(req, env, ctx as any);
  const body = await res.text();
  await Promise.all(ctx._promises);
  return { res, body };
}

// Unlike run(), leaves the body unread for the caller to parse.
async function rawRun(env: Env, req: Request): Promise<Response> {
  const ctx = createMockExecutionCtx();
  const res = await app.fetch(req, env, ctx as any);
  await Promise.all(ctx._promises);
  return res;
}

function mcp(bearer: string, payload: object): Request {
  return new Request(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...payload }),
  });
}

const toolsList = (bearer: string) => mcp(bearer, { method: "tools/list" });
const send = (bearer: string) =>
  mcp(bearer, {
    method: "tools/call",
    params: { name: "send_notification", arguments: { channel: "discord-main", content: { text: "hi" } } },
  });

function rpcResult(body: string): any {
  const dataLine = body.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(dataLine ? dataLine.slice("data:".length).trim() : body).result;
}

async function notifySends(env: Env): Promise<any[]> {
  const kv = env.OAUTH_KV as unknown as MockKV;
  const listed = await kv.list({ prefix: "audit:" });
  const entries = await Promise.all(listed.keys.map(({ name }) => kv.get(name, "json")));
  return entries.filter((e: any) => e.event === "notify.send");
}

// The resolver in src/index.ts refuses a dvct bearer before src/api.ts sees
// it; the provider then answers "Invalid access token". src/api.ts refuses
// with its own descriptions, so the description names the layer that refused.
const RESOLVER_REFUSAL = "Invalid access token";

async function expectRefusedByResolver(res: Response) {
  expectInvalidToken(res);
  expect(((await res.json()) as { error_description: string }).error_description).toBe(RESOLVER_REFUSAL);
}

function expectInvalidToken(res: Response) {
  expect(res.status).toBe(401);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  const challenge = res.headers.get("WWW-Authenticate") ?? "";
  expect(challenge).toMatch(/^Bearer /);
  expect(challenge).toContain('error="invalid_token"');
  expect(challenge).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
}

test("/mcp serves tools/list to a live dvct bearer", async () => {
  const env = await makeEnv();
  const { token } = await issueToken({ userId: "alice", scopes: ["dovecote:notify"] }, env);
  const { res, body } = await run(env, toolsList(token));
  expect(res.status).toBe(200);
  expect(rpcResult(body).tools.map((t: { name: string }) => t.name)).toContain("send_notification");
});

test("send_notification over a live dvct bearer writes one notify.send with its tokenId and label", async () => {
  const env = await makeEnv();
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ id: "msg-1", channel_id: "ch-1" }), { status: 200 })),
  ) as any;
  const { token, tokenId } = await issueToken({ userId: "alice", scopes: ["dovecote:notify"], label: LABEL }, env);
  const { res, body } = await run(env, send(token));
  expect(res.status).toBe(200);
  expect(rpcResult(body).isError).toBeUndefined();
  const audits = await notifySends(env);
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    ok: true,
    userId: "alice",
    tokenId,
    authMethod: "api_token",
    label: LABEL,
    channel: "discord-main",
  });
});

test("/mcp answers 401 invalid_token to a revoked dvct bearer", async () => {
  const env = await makeEnv();
  const { token, tokenId } = await issueToken({ userId: "alice", scopes: ["dovecote:notify"] }, env);
  expect((await revokeToken({ tokenId, env }, env)).revoked).toBe(true);
  await expectRefusedByResolver(await rawRun(env, toolsList(token)));
});

test("/mcp answers 401 invalid_token to an expired dvct bearer", async () => {
  const env = await makeEnv();
  const issuedLongAgo = Date.now() - DEFAULT_TTL_SECONDS * 1000 - 1;
  const { token } = await issueToken({ userId: "alice", scopes: ["dovecote:notify"] }, env, issuedLongAgo);
  await expectRefusedByResolver(await rawRun(env, toolsList(token)));
});

test("/mcp answers 401 invalid_token to a well-formed dvct bearer that was never issued", async () => {
  const env = await makeEnv();
  await expectRefusedByResolver(await rawRun(env, toolsList("dvct_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")));
});

test("/mcp answers 401 invalid_token to a bearer that is not a dvct token", async () => {
  const env = await makeEnv();
  await expectRefusedByResolver(await rawRun(env, toolsList("not-a-token")));
});

test("/mcp answers 401 invalid_token when the tokenId record is kept but the hash record is gone", async () => {
  const env = await makeEnv();
  const { token, tokenId } = await issueToken({ userId: "alice", scopes: ["dovecote:notify"] }, env);
  const kv = env.OAUTH_KV as unknown as MockKV;
  const hashKeys = (await kv.list({ prefix: KV_HASH_NAMESPACE })).keys;
  expect(hashKeys).toHaveLength(1);
  await kv.delete(hashKeys[0]!.name);
  expect(await kv.get(`apitoken:${tokenId}`)).not.toBeNull();
  await expectRefusedByResolver(await rawRun(env, toolsList(token)));
});

test("/mcp answers 500 without echoing the bearer when the resolver's KV read fails", async () => {
  const env = await makeEnv();
  const { token } = await issueToken({ userId: "alice", scopes: ["dovecote:notify"] }, env);
  const kv = env.OAUTH_KV as unknown as MockKV;
  const realGet = kv.get.bind(kv);
  kv.get = (async (key: string, options?: any) => {
    if (key.startsWith(KV_HASH_NAMESPACE)) throw new Error("KV unavailable");
    return realGet(key, options);
  }) as MockKV["get"];
  const res = await rawRun(env, toolsList(token));
  expect(res.status).toBe(500);
  expect(await res.text()).not.toContain(token);
});

test("send_notification refuses a dvct bearer without dovecote:notify exactly as it refuses such an OAuth grant", async () => {
  const env = await makeEnv();
  const { token } = await issueToken({ userId: "alice", scopes: ["dovecote:admin"] }, env);
  const viaBearer = await run(env, send(token));
  expect(viaBearer.res.status).toBe(200);
  const bearerResult = rpcResult(viaBearer.body);
  expect(bearerResult.isError).toBe(true);
  expect(bearerResult.content[0].text).toBe("Forbidden: missing scope dovecote:notify");

  const doFetch = (req: Request) => Promise.resolve(app.fetch(req, env, createMockExecutionCtx() as any));
  const boot = await doFetch(
    new Request(`${BASE}/admin/bootstrap-client`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer admin-token-123" },
      body: JSON.stringify({ clientName: "c", redirectUris: [REDIRECT_URI] }),
    }),
  );
  const clientId = ((await boot.json()) as { client_id: string }).client_id;
  const { accessToken } = await runFormOAuthFlow({
    doFetch,
    env,
    clientId,
    redirectUri: REDIRECT_URI,
    scope: "dovecote:admin",
    tokenScopes: ["dovecote:admin"],
    state: "s",
    userId: "alice",
    baseUrl: BASE,
  });
  expect(rpcResult((await run(env, send(accessToken))).body)).toEqual(bearerResult);
});
