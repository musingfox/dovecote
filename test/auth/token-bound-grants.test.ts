import { test, expect } from "bun:test";
import { getOAuthApi, GrantType, OAuthError } from "@cloudflare/workers-oauth-provider";
import { refuseRefreshOfUnboundGrant } from "../../src/auth/refresh-binding.js";
import app from "../../src/index.js";
import apiApp from "../../src/api.js";
import { issueToken, revokeToken } from "../../src/auth/api-token.js";
import type { Env } from "../../src/types.js";
import { MockKV } from "../helpers/mock-kv.js";
import { createMockExecutionCtx } from "../helpers/mock-execution-ctx.js";
import { runFormOAuthFlow } from "../helpers/form-oauth.js";

// A grant is bound to the dvct token pasted at /authorize: /mcp re-checks that
// token on every request, driven here through the real provider.

const BASE = "https://example.com";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

function makeEnv(): Env {
  return {
    OAUTH_KV: new MockKV() as any,
    HMAC_PEPPER: "test-pepper",
    ADMIN_REVOKE_TOKEN: "admin-token-123",
    ENABLE_CLIENT_BOOTSTRAP: "1",
  };
}

function fetcher(env: Env) {
  return (req: Request) => Promise.resolve(app.fetch(req, env, createMockExecutionCtx() as any));
}

async function authorize(env: Env, label?: string, scopes: string[] = ["dovecote:notify"]) {
  const doFetch = fetcher(env);
  const res = await doFetch(
    new Request(`${BASE}/admin/bootstrap-client`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer admin-token-123" },
      body: JSON.stringify({ clientName: "c", redirectUris: [REDIRECT_URI] }),
    }),
  );
  const clientId = ((await res.json()) as { client_id: string }).client_id;
  const flow = await runFormOAuthFlow({
    doFetch,
    env,
    clientId,
    redirectUri: REDIRECT_URI,
    scope: scopes.join(" "),
    tokenScopes: scopes,
    state: "s",
    userId: "alice",
    label,
    baseUrl: BASE,
  });
  return { ...flow, clientId, doFetch };
}

async function rewriteBoundToken(env: Env, tokenId: string, patch: Record<string, unknown>) {
  const kv = env.OAUTH_KV as unknown as MockKV;
  const record = (await kv.get(`apitoken:${tokenId}`, "json")) as Record<string, unknown>;
  await kv.put(`apitoken:${tokenId}`, JSON.stringify({ ...record, ...patch }));
}

function refresh(clientId: string, refreshToken: string): Request {
  return new Request(`${BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }).toString(),
  });
}

function toolsList(accessToken: string): Request {
  return new Request(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

function expectInvalidToken(res: Response) {
  expect(res.status).toBe(401);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  const challenge = res.headers.get("WWW-Authenticate") ?? "";
  expect(challenge).toMatch(/^Bearer /);
  expect(challenge).toContain('error="invalid_token"');
  expect(challenge).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
}

test("POST /authorize records the dvct tokenId and label in the grant metadata", async () => {
  const env = makeEnv();
  const { tokenId } = await authorize(env, "alice-laptop");
  const noop = { fetch: () => new Response(null, { status: 404 }) };
  const grants = await getOAuthApi(
    {
      apiHandler: noop,
      apiRoute: "/mcp",
      defaultHandler: noop,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      resourceMetadata: { resource: `${BASE}/mcp` },
    },
    env,
  ).listUserGrants("alice");
  expect(grants.items).toHaveLength(1);
  expect(grants.items[0]!.metadata).toEqual({ tokenId, label: "alice-laptop" });
});

test("/mcp serves a grant whose dvct token is still live", async () => {
  const env = makeEnv();
  const { accessToken, doFetch } = await authorize(env);
  const res = await doFetch(toolsList(accessToken));
  expect(res.status).toBe(200);
});

test("/mcp answers 401 invalid_token once the bound dvct token is revoked", async () => {
  const env = makeEnv();
  const { accessToken, tokenId, doFetch } = await authorize(env);
  expect((await revokeToken({ tokenId, env }, env)).revoked).toBe(true);
  expectInvalidToken(await doFetch(toolsList(accessToken)));
});

test("/mcp answers 401 invalid_token once the bound dvct token has expired", async () => {
  const env = makeEnv();
  const { accessToken, tokenId, doFetch } = await authorize(env);
  await rewriteBoundToken(env, tokenId, { expiresAt: Date.now() - 1 });
  expectInvalidToken(await doFetch(toolsList(accessToken)));
});

test("/mcp answers 401 invalid_token when the bound dvct token belongs to another user", async () => {
  const env = makeEnv();
  const { accessToken, tokenId, doFetch } = await authorize(env);
  await rewriteBoundToken(env, tokenId, { userId: "bob" });
  expectInvalidToken(await doFetch(toolsList(accessToken)));
});

// /mcp refusing is not enough on its own: an MCP client refreshes on 401, and
// only a failed refresh sends it back through /authorize.
test("refresh_token still succeeds while the bound dvct token is live", async () => {
  const env = makeEnv();
  const { clientId, refreshToken, doFetch } = await authorize(env);
  const res = await doFetch(refresh(clientId, refreshToken!));
  expect(res.status).toBe(200);
  expect(((await res.json()) as { access_token?: string }).access_token).toBeString();
});

test("refresh_token answers 400 invalid_grant once the bound dvct token is revoked", async () => {
  const env = makeEnv();
  const { clientId, refreshToken, tokenId, doFetch } = await authorize(env);
  expect((await revokeToken({ tokenId, env }, env)).revoked).toBe(true);
  const res = await doFetch(refresh(clientId, refreshToken!));
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
});

test("refresh of a grant whose props carry no tokenId throws invalid_grant", async () => {
  const env = makeEnv();
  await issueToken({ userId: "alice", scopes: ["dovecote:notify"] }, env);
  const attempt = refuseRefreshOfUnboundGrant({
    grantType: GrantType.REFRESH_TOKEN,
    clientId: "c",
    subjectClientId: "c",
    userId: "alice",
    grantId: "g",
    scope: ["dovecote:notify"],
    requestedScope: ["dovecote:notify"],
    resource: `${BASE}/mcp`,
    props: { userId: "alice", scopes: ["dovecote:notify"], authMethod: "api_token" },
    env,
  });
  await expect(attempt).rejects.toBeInstanceOf(OAuthError);
  await expect(attempt).rejects.toMatchObject({ code: "invalid_grant" });
});

// Grants authorized before tokens were bound carry no tokenId; they are
// refused so the client re-authorizes once and gets a bound grant.
test("/mcp answers 401 invalid_token for a grant whose props carry no tokenId", async () => {
  const env = makeEnv();
  await issueToken({ userId: "alice", scopes: ["dovecote:notify"] }, env);
  const ctx = createMockExecutionCtx({ userId: "alice", scopes: ["dovecote:notify"], authMethod: "api_token" });
  expectInvalidToken(await apiApp.fetch(toolsList("unused"), env, ctx as any));
});

// /v1/auth/exchange trades an OAuth access token for a new dvct token, so it
// must honour the same binding or a revoked credential could mint a fresh one.
const ADMIN = ["dovecote:admin", "dovecote:notify"];

function exchange(accessToken: string): Request {
  return new Request(`${BASE}/v1/auth/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ label: "cli" }),
  });
}

test("/v1/auth/exchange still trades a grant whose dvct token is live", async () => {
  const env = makeEnv();
  const { accessToken, doFetch } = await authorize(env, undefined, ADMIN);
  expect((await doFetch(exchange(accessToken))).status).toBe(201);
});

test("/v1/auth/exchange refuses a grant whose bound dvct token was revoked", async () => {
  const env = makeEnv();
  const { accessToken, tokenId, doFetch } = await authorize(env, undefined, ADMIN);
  expect((await revokeToken({ tokenId, env }, env)).revoked).toBe(true);
  const res = await doFetch(exchange(accessToken));
  expect(res.status).toBe(401);
});

test("/v1/auth/exchange refuses a grant whose bound dvct token has expired", async () => {
  const env = makeEnv();
  const { accessToken, tokenId, doFetch } = await authorize(env, undefined, ADMIN);
  await rewriteBoundToken(env, tokenId, { expiresAt: Date.now() - 1 });
  expect((await doFetch(exchange(accessToken))).status).toBe(401);
});

test("/v1/auth/exchange refuses a grant whose bound dvct token belongs to another user", async () => {
  const env = makeEnv();
  const { accessToken, tokenId, doFetch } = await authorize(env, undefined, ADMIN);
  await rewriteBoundToken(env, tokenId, { userId: "bob" });
  expect((await doFetch(exchange(accessToken))).status).toBe(401);
});
