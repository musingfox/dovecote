import { test, expect } from "bun:test";
import app from "../../src/index.js";
import { config } from "./config.js";
import { createMockExecutionCtx } from "../helpers/mock-execution-ctx.js";
import { runFormOAuthFlow } from "../helpers/form-oauth.js";

/**
 * Smoke tests: basic OAuth and MCP flow validation
 * - Can run against local (in-process with MockKV) or remote deployed worker
 * - Set TEST_BASE_URL for remote testing
 * - C5/C6 use the M1 token-paste form flow (OIDC RP retired)
 */

async function doFetch(path: string, init?: RequestInit, env?: any): Promise<Response> {
  if (config.isRemote) {
    const url = `${config.baseUrl}${path}`;
    return fetch(url, init);
  } else {
    const url = `http://localhost${path}`;
    const ctx = createMockExecutionCtx();
    return app.fetch(new Request(url, init), env ?? config.env, ctx as any);
  }
}

test("C2: GET /.well-known/oauth-authorization-server returns metadata", async () => {
  const res = await doFetch("/.well-known/oauth-authorization-server");

  expect(res.status).toBe(200);

  const json: any = await res.json();
  expect(json.authorization_endpoint).toBeTruthy();
  expect(json.token_endpoint).toBeTruthy();
  expect(json.scopes_supported).toContain("dovecote:notify");
});

test("C3: POST /register is closed (returns 4xx)", async () => {
  const res = await doFetch("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "test-client",
      redirect_uris: ["https://example.com/callback"],
      token_endpoint_auth_method: "none",
    }),
  });

  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.status).toBeLessThan(500);
});

test("C4: POST /admin/bootstrap-client returns 404 when ENABLE_CLIENT_BOOTSTRAP is unset", async () => {
  if (config.isRemote) {
    const res = await doFetch("/admin/bootstrap-client", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.env.ADMIN_REVOKE_TOKEN || "test-token"}`,
      },
      body: JSON.stringify({
        clientName: "test-client",
        redirectUris: ["https://example.com/callback"],
      }),
    });

    expect(res.status).toBe(404);
  } else {
    const originalValue = config.env.ENABLE_CLIENT_BOOTSTRAP;
    config.env.ENABLE_CLIENT_BOOTSTRAP = undefined;

    const res = await doFetch("/admin/bootstrap-client", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.env.ADMIN_REVOKE_TOKEN}`,
      },
      body: JSON.stringify({
        clientName: "test-client",
        redirectUris: ["https://example.com/callback"],
      }),
    });

    expect(res.status).toBe(404);

    config.env.ENABLE_CLIENT_BOOTSTRAP = originalValue;
  }
});

test.skipIf(config.isRemote)("C5: Full OAuth flow via token-paste form succeeds (local only)", async () => {
  const env = { ...config.env, ENABLE_CLIENT_BOOTSTRAP: "1" };

  // Step 1: Bootstrap client
  const bootstrapRes = await doFetch(
    "/admin/bootstrap-client",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.ADMIN_REVOKE_TOKEN}`,
      },
      body: JSON.stringify({
        clientName: "smoke-test-client",
        redirectUris: ["https://test.local/callback"],
      }),
    },
    env,
  );

  expect(bootstrapRes.status).toBe(200);
  const clientInfo: any = await bootstrapRes.json();
  const clientId = clientInfo.client_id;

  // Steps 2-5: dvct mint → GET form → POST token → code → access token (PKCE)
  const { accessToken } = await runFormOAuthFlow({
    doFetch: (req) => Promise.resolve(app.fetch(req, env, createMockExecutionCtx() as any)),
    env,
    clientId,
    redirectUri: "https://test.local/callback",
    scope: "dovecote:notify",
    state: "s1",
    userId: "alice",
    tokenScopes: ["dovecote:notify"],
  });
  expect(accessToken).toBeTruthy();

  // Step 6: Use access token to call MCP list_channels
  const mcpRes = await doFetch(
    "/mcp",
    {
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
        params: {
          name: "list_channels",
          arguments: {},
        },
      }),
    },
    env,
  );

  expect(mcpRes.status).toBe(200);
  const mcpText = await mcpRes.text();

  const dataLine = mcpText
    .split("\n")
    .find((line) => line.startsWith("data: "));
  expect(dataLine).toBeTruthy();

  const mcpData = JSON.parse(dataLine!.slice(6));

  expect(mcpData.result || mcpData.error).toBeTruthy();
  if (mcpData.error) {
    expect(mcpData.error.code).not.toBe(401);
    expect(mcpData.error.code).not.toBe(403);
  }
  // Scope must have carried through the grant — never Forbidden.
  if (mcpData.result) {
    expect(mcpData.result.content[0].text).not.toMatch(/Forbidden/);
  }
});

test.skipIf(config.isRemote)("C6: Admin revoke invalidates access token from the form flow (local only)", async () => {
  const env = { ...config.env, ENABLE_CLIENT_BOOTSTRAP: "1" };

  // Step 1: Bootstrap client + run the form flow to get an access token
  const bootstrapRes = await doFetch(
    "/admin/bootstrap-client",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.ADMIN_REVOKE_TOKEN}`,
      },
      body: JSON.stringify({
        clientName: "revoke-test-client",
        redirectUris: ["https://test.local/callback"],
      }),
    },
    env,
  );

  const clientInfo: any = await bootstrapRes.json();
  const clientId = clientInfo.client_id;

  const userId = "alice";
  const { accessToken } = await runFormOAuthFlow({
    doFetch: (req) => Promise.resolve(app.fetch(req, env, createMockExecutionCtx() as any)),
    env,
    clientId,
    redirectUri: "https://test.local/callback",
    scope: "dovecote:notify",
    state: "s2",
    userId,
    tokenScopes: ["dovecote:notify"],
  });

  // Extract grantId from access token (format: {userId}:{grantId}:{tokenSecret})
  const tokenParts = accessToken.split(":");
  expect(tokenParts.length).toBeGreaterThanOrEqual(2);
  const grantId = tokenParts[1];

  if (!grantId) {
    console.warn("Could not extract grantId from access token, skipping C6 revoke test");
    return;
  }

  // Verify grant exists in KV before revocation
  const kv = env.OAUTH_KV as any;
  const grantKey = `grant:${userId}:${grantId}`;
  const grantBeforeRevoke = await kv.get(grantKey);
  expect(grantBeforeRevoke).not.toBeNull();

  // Revoke the grant (userId required by revoke schema)
  const revokeRes = await doFetch(
    "/admin/revoke",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.ADMIN_REVOKE_TOKEN}`,
      },
      body: JSON.stringify({ grantId, userId }),
    },
    env,
  );

  expect(revokeRes.status).toBe(200);

  // Verify grant was deleted from KV
  const grantAfterRevoke = await kv.get(grantKey);
  expect(grantAfterRevoke).toBeNull();

  // Verify token keys were deleted
  const tokenKeys = await kv.list({ prefix: `token:${userId}:${grantId}:` });
  expect(tokenKeys.keys.length).toBe(0);

  // Poll until access token is invalid
  const pollStart = Date.now();
  const pollTimeout = 10000;
  let isRevoked = false;

  while (Date.now() - pollStart < pollTimeout) {
    const mcpRes = await doFetch(
      "/mcp",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0" },
          },
        }),
      },
      env,
    );

    if (mcpRes.status === 401) {
      isRevoked = true;
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  expect(isRevoked).toBe(true);
});
