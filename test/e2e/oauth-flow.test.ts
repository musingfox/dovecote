import { test, expect } from "bun:test";
import type { Env } from "../../src/types.js";
import app from "../../src/index.js";
import { createMockExecutionCtx } from "../helpers/mock-execution-ctx.js";
import { MockKV } from "../helpers/mock-kv.js";
import { runFormOAuthFlow } from "../helpers/form-oauth.js";

/**
 * Full OAuth flow (M1 token-paste form): the browser leg pastes a dvct_*
 * token instead of bouncing to an IdP. Runs fully in-process with MockKV.
 */

function makeEnv(): Env {
  return {
    OAUTH_KV: new MockKV() as any,
    HMAC_PEPPER: "test-pepper",
    ADMIN_REVOKE_TOKEN: "admin-token-123",
    ENABLE_CLIENT_BOOTSTRAP: "1",
  };
}

test("GET /.well-known/oauth-authorization-server returns metadata", async () => {
  const env = makeEnv();
  const req = new Request("https://example.com/.well-known/oauth-authorization-server");
  const res = await app.fetch(req, env, createMockExecutionCtx() as any);

  expect(res.status).toBe(200);

  const json = await res.json() as {
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint: string;
    scopes_supported: string[];
    code_challenge_methods_supported: string[];
  };
  expect(json.authorization_endpoint).toBeTruthy();
  expect(json.token_endpoint).toBeTruthy();
  expect(json.registration_endpoint).toBeTruthy();
  expect(json.scopes_supported).toContain("dovecote:notify");
  expect(json.code_challenge_methods_supported).toContain("S256");
  expect(json.code_challenge_methods_supported).not.toContain("plain");
});

test("GET /.well-known/oauth-protected-resource returns metadata", async () => {
  const env = makeEnv();
  const req = new Request("https://example.com/.well-known/oauth-protected-resource");
  const res = await app.fetch(req, env, createMockExecutionCtx() as any);

  expect(res.status).toBe(200);

  const json = await res.json() as { resource: string };
  expect(json.resource).toBeTruthy();
});

test("POST /mcp without Authorization returns 401", async () => {
  const env = makeEnv();
  const req = new Request("https://example.com/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    }),
  });

  const res = await app.fetch(req, env, createMockExecutionCtx() as any);
  expect(res.status).toBe(401);

  const wwwAuth = res.headers.get("WWW-Authenticate");
  expect(wwwAuth).toBeTruthy();
  expect(wwwAuth).toContain("resource_metadata");
});

test("Full OAuth flow via token-paste form: Bootstrap -> GET form -> POST token -> Token -> non-anonymous MCP access", async () => {
  const env = makeEnv();
  const doFetch = (req: Request) =>
    Promise.resolve(app.fetch(req, env, createMockExecutionCtx() as any));

  // Step 1: Bootstrap client
  const bootstrapRes = await doFetch(
    new Request("https://example.com/admin/bootstrap-client", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer admin-token-123",
      },
      body: JSON.stringify({
        clientName: "test-client",
        redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
      }),
    }),
  );
  expect(bootstrapRes.status).toBe(200);

  const clientInfo = await bootstrapRes.json() as { client_id: string };
  expect(clientInfo.client_id).toBeTruthy();

  // Steps 2-5: mint dvct → form → POST → code → token (PKCE)
  const { accessToken } = await runFormOAuthFlow({
    doFetch,
    env,
    clientId: clientInfo.client_id,
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    scope: "dovecote:notify",
    state: "s1",
    userId: "alice",
    tokenScopes: ["dovecote:notify"],
    baseUrl: "https://example.com",
  });
  expect(accessToken).toBeTruthy();

  // Step 6: access token drives /mcp — tools/call must NOT be Forbidden,
  // proving the grant props carried a real identity + scopes (not ANONYMOUS).
  const mcpRes = await doFetch(
    new Request("https://example.com/mcp", {
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
        params: { name: "list_channels", arguments: {} },
      }),
    }),
  );
  expect(mcpRes.status).toBe(200);

  const mcpText = await mcpRes.text();
  const dataLine = mcpText.split("\n").find((l) => l.startsWith("data: "));
  expect(dataLine).toBeTruthy();
  const mcpData = JSON.parse(dataLine!.slice(6));
  expect(mcpData.result).toBeTruthy();
  const toolText: string = mcpData.result.content[0].text;
  expect(toolText).not.toMatch(/Forbidden/);
  expect(mcpData.result.isError).toBeUndefined();
});
