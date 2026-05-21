import { test, expect } from "bun:test";
import type { Env } from "../../src/types.js";
import app from "../../src/index.js";
import { createMockExecutionCtx } from "../helpers/mock-execution-ctx.js";
import { generateCodeVerifier, generateCodeChallenge } from "../helpers/pkce.js";
import { MockKV } from "../helpers/mock-kv.js";

const mockEnv: Env = {
  OAUTH_KV: new MockKV() as any,
  OAUTH_PASSWORD: "test-password",
  COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length-required",
  HMAC_PEPPER: "test-pepper",
  TELEGRAM_INSTANCES: undefined,
  DISCORD_INSTANCES: undefined,
  ADMIN_REVOKE_TOKEN: "admin-token-123",
  ENABLE_CLIENT_BOOTSTRAP: "1",
};

test("GET /.well-known/oauth-authorization-server returns metadata", async () => {
  const req = new Request("https://example.com/.well-known/oauth-authorization-server");
  const res = await app.fetch(req, mockEnv, createMockExecutionCtx() as any);

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
  const req = new Request("https://example.com/.well-known/oauth-protected-resource");
  const res = await app.fetch(req, mockEnv, createMockExecutionCtx() as any);

  expect(res.status).toBe(200);

  const json = await res.json() as { resource: string };
  expect(json.resource).toBeTruthy();
});

test("POST /mcp without Authorization returns 401", async () => {
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

  const res = await app.fetch(req, mockEnv, createMockExecutionCtx() as any);
  expect(res.status).toBe(401);

  const wwwAuth = res.headers.get("WWW-Authenticate");
  expect(wwwAuth).toBeTruthy();
  expect(wwwAuth).toContain("resource_metadata");
});

test("Full OAuth flow: Bootstrap -> Authorize -> Token -> API access", async () => {
  // Step 1: Bootstrap client (DCR is now closed, use admin endpoint)
  const bootstrapReq = new Request("https://example.com/admin/bootstrap-client", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer admin-token-123",
    },
    body: JSON.stringify({
      clientName: "test-client",
      redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    }),
  });

  const bootstrapRes = await app.fetch(bootstrapReq, mockEnv, createMockExecutionCtx() as any);
  expect(bootstrapRes.status).toBe(200);

  const clientInfo = await bootstrapRes.json() as { client_id: string };
  expect(clientInfo.client_id).toBeTruthy();
  const clientId = clientInfo.client_id;

  // Step 2: Generate PKCE verifier and challenge
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  // Step 3: GET /authorize to get the form
  const authorizeUrl = new URL("https://example.com/authorize");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", "https://claude.ai/api/mcp/auth_callback");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", "s1");
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("scope", "dovecote:notify");

  const authorizeGetReq = new Request(authorizeUrl.toString());
  const authorizeGetRes = await app.fetch(authorizeGetReq, mockEnv, createMockExecutionCtx() as any);
  expect(authorizeGetRes.status).toBe(200);

  const html = await authorizeGetRes.text();
  const csrfMatch = html.match(/name="csrf_token" value="([^"]+)"/);
  expect(csrfMatch).toBeTruthy();
  const csrfToken = csrfMatch![1]!;

  const setCookie = authorizeGetRes.headers.get("Set-Cookie");
  expect(setCookie).toBeTruthy();
  const cookieMatch = setCookie!.match(/csrf=([^;]+)/);
  expect(cookieMatch).toBeTruthy();
  const cookieValue = cookieMatch![1]!;

  // Step 4: POST /authorize with form data
  const authorizeFormData = new FormData();
  authorizeFormData.append("csrf_token", csrfToken);
  authorizeFormData.append("password", "test-password");
  authorizeFormData.append("response_type", "code");
  authorizeFormData.append("client_id", clientId);
  authorizeFormData.append("redirect_uri", "https://claude.ai/api/mcp/auth_callback");
  authorizeFormData.append("state", "s1");
  authorizeFormData.append("scope", "dovecote:notify");
  authorizeFormData.append("code_challenge", codeChallenge);
  authorizeFormData.append("code_challenge_method", "S256");

  const authorizePostReq = new Request("https://example.com/authorize", {
    method: "POST",
    headers: {
      Cookie: `csrf=${cookieValue}`,
    },
    body: authorizeFormData,
  });

  const authorizePostRes = await app.fetch(authorizePostReq, mockEnv, createMockExecutionCtx() as any);
  expect(authorizePostRes.status).toBe(302);

  const location = authorizePostRes.headers.get("Location");
  expect(location).toBeTruthy();
  expect(location).toContain("code=");
  expect(location).toContain("state=s1");

  // Extract authorization code from redirect
  const locationUrl = new URL(location!);
  const code = locationUrl.searchParams.get("code");
  expect(code).toBeTruthy();

  const state = locationUrl.searchParams.get("state");
  expect(state).toBe("s1");

  // Step 5: Exchange code for token
  const tokenFormData = new URLSearchParams();
  tokenFormData.set("grant_type", "authorization_code");
  tokenFormData.set("code", code!);
  tokenFormData.set("redirect_uri", "https://claude.ai/api/mcp/auth_callback");
  tokenFormData.set("client_id", clientId);
  tokenFormData.set("code_verifier", codeVerifier);

  const tokenReq = new Request("https://example.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: tokenFormData.toString(),
  });

  const tokenRes = await app.fetch(tokenReq, mockEnv, createMockExecutionCtx() as any);
  expect(tokenRes.status).toBe(200);

  const tokenData = await tokenRes.json() as { access_token: string; refresh_token: string; token_type: string };
  expect(tokenData.access_token).toBeTruthy();
  expect(tokenData.refresh_token).toBeTruthy();
  expect(tokenData.token_type.toLowerCase()).toBe("bearer");

  // Step 6: Use access token to call MCP API
  const mcpReq = new Request("https://example.com/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${tokenData.access_token}`,
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

  const mcpRes = await app.fetch(mcpReq, mockEnv, createMockExecutionCtx() as any);
  expect(mcpRes.status).toBe(200);

  const mcpText = await mcpRes.text();
  expect(mcpText).toContain("dovecote-mcp-server");
});

