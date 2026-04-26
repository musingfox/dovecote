import { describe, test, expect } from "bun:test";
import app from "../../src/index.js";
import { config } from "./config.js";
import { createMockExecutionCtx } from "../helpers/mock-execution-ctx.js";
import { generateCodeVerifier, generateCodeChallenge } from "../helpers/pkce.js";

/**
 * Smoke tests: basic OAuth and MCP flow validation
 * - Can run against local (in-process with MockKV) or remote deployed worker
 * - Set TEST_BASE_URL for remote testing
 */

async function doFetch(path: string, init?: RequestInit): Promise<Response> {
  if (config.isRemote) {
    // Remote mode: use global fetch
    const url = `${config.baseUrl}${path}`;
    return fetch(url, init);
  } else {
    // Local mode: use app.fetch
    const url = `http://localhost${path}`;
    const ctx = createMockExecutionCtx();
    return app.fetch(new Request(url, init), config.env, ctx as any);
  }
}

test("C2: GET /.well-known/oauth-authorization-server returns metadata", async () => {
  const res = await doFetch("/.well-known/oauth-authorization-server");

  expect(res.status).toBe(200);

  const json: any = await res.json();
  expect(json.authorization_endpoint).toBeTruthy();
  expect(json.token_endpoint).toBeTruthy();
  expect(json.scopes_supported).toContain("dovecote:notify");
  expect(json.scopes_supported).toContain("dovecote:env:read");
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

  // DCR is closed, so we expect a 4xx error (exact code not specified by library)
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.status).toBeLessThan(500);
});

test("C4: POST /admin/bootstrap-client returns 404 when ENABLE_CLIENT_BOOTSTRAP is unset", async () => {
  if (config.isRemote) {
    // Remote mode: assume production doesn't have ENABLE_CLIENT_BOOTSTRAP set
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
    // Local mode: temporarily unset ENABLE_CLIENT_BOOTSTRAP
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

    // Restore original value
    config.env.ENABLE_CLIENT_BOOTSTRAP = originalValue;
  }
});

test.skipIf(config.isRemote)("C5: Full OAuth flow succeeds (local only)", async () => {
  // Ensure ENABLE_CLIENT_BOOTSTRAP is set for local testing
  config.env.ENABLE_CLIENT_BOOTSTRAP = "1";

  // Step 1: Bootstrap client
  const bootstrapRes = await doFetch("/admin/bootstrap-client", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.env.ADMIN_REVOKE_TOKEN}`,
    },
    body: JSON.stringify({
      clientName: "smoke-test-client",
      redirectUris: ["https://test.local/callback"],
    }),
  });

  expect(bootstrapRes.status).toBe(200);
  const clientInfo: any = await bootstrapRes.json();
  const clientId = clientInfo.client_id;

  // Step 2: Generate PKCE
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  // Step 3: GET /authorize
  const authorizeGetRes = await doFetch(
    `/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(
      "https://test.local/callback"
    )}&response_type=code&state=s1&code_challenge=${codeChallenge}&code_challenge_method=S256&scope=dovecote:env:read`
  );

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

  // Step 4: POST /authorize
  const authorizeFormData = new FormData();
  authorizeFormData.append("csrf_token", csrfToken);
  authorizeFormData.append("password", config.env.OAUTH_PASSWORD);
  authorizeFormData.append("response_type", "code");
  authorizeFormData.append("client_id", clientId);
  authorizeFormData.append("redirect_uri", "https://test.local/callback");
  authorizeFormData.append("state", "s1");
  authorizeFormData.append("scope", "dovecote:env:read");
  authorizeFormData.append("code_challenge", codeChallenge);
  authorizeFormData.append("code_challenge_method", "S256");

  const authorizePostRes = await doFetch("/authorize", {
    method: "POST",
    headers: { Cookie: `csrf=${cookieValue}` },
    body: authorizeFormData,
  });

  expect(authorizePostRes.status).toBe(302);
  const location = authorizePostRes.headers.get("Location");
  expect(location).toBeTruthy();
  const locationUrl = new URL(location!);
  const code = locationUrl.searchParams.get("code");
  expect(code).toBeTruthy();

  // Step 5: Exchange code for token
  const tokenFormData = new URLSearchParams();
  tokenFormData.set("grant_type", "authorization_code");
  tokenFormData.set("code", code!);
  tokenFormData.set("redirect_uri", "https://test.local/callback");
  tokenFormData.set("client_id", clientId);
  tokenFormData.set("code_verifier", codeVerifier);

  const tokenRes = await doFetch("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenFormData.toString(),
  });

  expect(tokenRes.status).toBe(200);
  const tokenData: any = await tokenRes.json();
  expect(tokenData.access_token).toBeTruthy();

  // Step 6: Use access token to call MCP get_env
  const mcpReq = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "get_env",
      arguments: { profile: "test-profile" },
    },
  };

  const mcpRes = await doFetch("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${tokenData.access_token}`,
    },
    body: JSON.stringify(mcpReq),
  });

  expect(mcpRes.status).toBe(200);
  const mcpText = await mcpRes.text();

  // Parse SSE response
  const dataLine = mcpText
    .split("\n")
    .find((line) => line.startsWith("data: "));
  expect(dataLine).toBeTruthy();

  const mcpData = JSON.parse(dataLine!.slice(6));

  // We expect a result (not an auth error)
  // It may be an error result (profile not found), but should not be 401/403
  expect(mcpData.result || mcpData.error).toBeTruthy();
  if (mcpData.error) {
    // If it's an error, it should not be an auth error
    expect(mcpData.error.code).not.toBe(401);
    expect(mcpData.error.code).not.toBe(403);
  }
});

test.skipIf(config.isRemote)("C6: Admin revoke invalidates access token (local only)", async () => {
  // This test depends on C5, so we repeat the full flow to get a token
  config.env.ENABLE_CLIENT_BOOTSTRAP = "1";

  // Step 1-5: Get access token (same as C5)
  const bootstrapRes = await doFetch("/admin/bootstrap-client", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.env.ADMIN_REVOKE_TOKEN}`,
    },
    body: JSON.stringify({
      clientName: "revoke-test-client",
      redirectUris: ["https://test.local/callback"],
    }),
  });

  const clientInfo: any = await bootstrapRes.json();
  const clientId = clientInfo.client_id;

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const authorizeGetRes = await doFetch(
    `/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(
      "https://test.local/callback"
    )}&response_type=code&state=s2&code_challenge=${codeChallenge}&code_challenge_method=S256&scope=dovecote:env:read`
  );

  const html = await authorizeGetRes.text();
  const csrfMatch = html.match(/name="csrf_token" value="([^"]+)"/);
  const csrfToken = csrfMatch![1]!;
  const setCookie = authorizeGetRes.headers.get("Set-Cookie")!;
  const cookieMatch = setCookie.match(/csrf=([^;]+)/);
  const cookieValue = cookieMatch![1]!;

  const authorizeFormData = new FormData();
  authorizeFormData.append("csrf_token", csrfToken);
  authorizeFormData.append("password", config.env.OAUTH_PASSWORD);
  authorizeFormData.append("response_type", "code");
  authorizeFormData.append("client_id", clientId);
  authorizeFormData.append("redirect_uri", "https://test.local/callback");
  authorizeFormData.append("state", "s2");
  authorizeFormData.append("scope", "dovecote:env:read");
  authorizeFormData.append("code_challenge", codeChallenge);
  authorizeFormData.append("code_challenge_method", "S256");

  const authorizePostRes = await doFetch("/authorize", {
    method: "POST",
    headers: { Cookie: `csrf=${cookieValue}` },
    body: authorizeFormData,
  });

  const location = authorizePostRes.headers.get("Location")!;
  const locationUrl = new URL(location);
  const code = locationUrl.searchParams.get("code")!;

  const tokenFormData = new URLSearchParams();
  tokenFormData.set("grant_type", "authorization_code");
  tokenFormData.set("code", code);
  tokenFormData.set("redirect_uri", "https://test.local/callback");
  tokenFormData.set("client_id", clientId);
  tokenFormData.set("code_verifier", codeVerifier);

  const tokenRes = await doFetch("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenFormData.toString(),
  });

  const tokenData: any = await tokenRes.json();
  const accessToken = tokenData.access_token;

  // Step 6: Extract grantId from access token
  // The access token format is {userId}:{grantId}:{tokenSecret}
  const tokenParts = accessToken.split(":");
  expect(tokenParts.length).toBeGreaterThanOrEqual(2);
  const grantId = tokenParts[1];

  if (!grantId) {
    console.warn("Could not extract grantId from access token, skipping C6 revoke test");
    return;
  }

  // Verify grant exists in KV before revocation
  const kv = config.env.OAUTH_KV as any;
  const grantKey = `grant:operator:${grantId}`;
  const grantBeforeRevoke = await kv.get(grantKey);
  expect(grantBeforeRevoke).not.toBeNull();

  // Step 7: Revoke the grant
  const revokeRes = await doFetch("/admin/revoke", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.env.ADMIN_REVOKE_TOKEN}`,
    },
    body: JSON.stringify({ grantId }),
  });

  expect(revokeRes.status).toBe(200);

  // Step 8: Verify grant was deleted from KV
  const grantAfterRevoke = await kv.get(grantKey);
  expect(grantAfterRevoke).toBeNull();

  // Step 9: Verify token keys were deleted from KV
  const tokenKeys = await kv.list({ prefix: `token:operator:${grantId}:` });
  expect(tokenKeys.keys.length).toBe(0);

  // Step 10: Poll until access token is invalid
  // In local mode with MockKV, revocation should be immediate or very fast
  const pollStart = Date.now();
  const pollTimeout = 10000; // 10 seconds
  let isRevoked = false;

  while (Date.now() - pollStart < pollTimeout) {
    const mcpRes = await doFetch("/mcp", {
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
    });

    if (mcpRes.status === 401) {
      isRevoked = true;
      break;
    }

    // Wait 500ms before next poll
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  expect(isRevoked).toBe(true);
});

