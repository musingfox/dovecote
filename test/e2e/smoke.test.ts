import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as jose from "jose";
import app from "../../src/index.js";
import { config } from "./config.js";
import { createMockExecutionCtx } from "../helpers/mock-execution-ctx.js";
import { generateCodeVerifier, generateCodeChallenge } from "../helpers/pkce.js";
// (removed) import { decodeOidcState } from "../../src/auth/oidc-rp-state.js";

/**
 * Smoke tests: basic OAuth and MCP flow validation
 * - Can run against local (in-process with MockKV) or remote deployed worker
 * - Set TEST_BASE_URL for remote testing
 * - C5/C6 use OIDC flow (form POST retired in turn-17)
 */

// ---- OIDC upstream mock (local only) -----------------------------------------

const ISSUER = "https://idp.smoke-test.example";
const AUDIENCE = "rp-smoke-client";
const RP_CLIENT_ID = "rp-smoke-client";
const TOKEN_ENDPOINT = `${ISSUER}/token`;
const JWKS_URI = `${ISSUER}/jwks`;
const STATE_SECRET = "smoke-state-secret-32-chars-min!!";

let kp: jose.GenerateKeyPairResult;
let pubJwk: jose.JWK;
const originalFetch = globalThis.fetch;
let capturedNonce = "";

beforeAll(async () => {
  kp = await jose.generateKeyPair("RS256", { extractable: true });
  pubJwk = await jose.exportJWK(kp.publicKey);
  pubJwk.kid = "smoke-kid";
  pubJwk.alg = "RS256";
  pubJwk.use = "sig";

  (globalThis as any).fetch = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;

    if (url === TOKEN_ENDPOINT || url.startsWith(TOKEN_ENDPOINT + "?")) {
      const now = Math.floor(Date.now() / 1000);
      const idToken = await new jose.SignJWT({ nonce: capturedNonce })
        .setProtectedHeader({ alg: "RS256", kid: "smoke-kid" })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setSubject("alice")
        .setIssuedAt(now - 10)
        .setExpirationTime(now + 3600)
        .sign(kp.privateKey);
      return new Response(JSON.stringify({ id_token: idToken }), { status: 200 });
    }

    if (url === JWKS_URI || url.startsWith(JWKS_URI + "?")) {
      return new Response(JSON.stringify({ keys: [pubJwk] }), { status: 200 });
    }

    return originalFetch(input as any, init);
  };
});

afterAll(() => {
  (globalThis as any).fetch = originalFetch;
});

// ---- env helpers --------------------------------------------------------------

function makeOidcEnv() {
  return {
    ...config.env,
    OIDC_STATE_SECRET: STATE_SECRET,
    OIDC_ISSUERS: JSON.stringify([
      {
        issuer: ISSUER,
        jwks_uri: JWKS_URI,
        audience: AUDIENCE,
        client_id: RP_CLIENT_ID,
        authorization_endpoint: `${ISSUER}/authorize`,
      },
    ]),
  };
}

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

test.skipIf(config.isRemote)("C5: Full OAuth flow via OIDC succeeds (local only)", async () => {
  const env = makeOidcEnv();
  env.ENABLE_CLIENT_BOOTSTRAP = "1";

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

  // Step 2: Generate PKCE
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  // Step 3: GET /authorize → 302 OIDC redirect (not form)
  const authorizeRes = await doFetch(
    `/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(
      "https://test.local/callback"
    )}&response_type=code&state=s1&code_challenge=${codeChallenge}&code_challenge_method=S256&scope=dovecote:notify`,
    undefined,
    env,
  );

  expect(authorizeRes.status).toBe(302);

  const upstreamLoc = authorizeRes.headers.get("Location") ?? "";
  expect(upstreamLoc.startsWith(`${ISSUER}/authorize`)).toBe(true);

  // Step 4: Decode state to extract nonce
  const upstreamParams = new URL(upstreamLoc).searchParams;
  const signedState = upstreamParams.get("state") ?? "";
  expect(signedState.length).toBeGreaterThan(0);

  const decoded = await decodeOidcState(signedState, STATE_SECRET);
  expect(decoded).not.toBeNull();
  capturedNonce = decoded!.nonce ?? "";
  expect(capturedNonce.length).toBeGreaterThan(0);

  // Step 5: Simulate IdP callback → GET /oidc/callback
  const callbackRes = await doFetch(
    `/oidc/callback?code=upstream-code&state=${encodeURIComponent(signedState)}`,
    undefined,
    env,
  );
  expect(callbackRes.status).toBe(302);

  const callbackLocation = callbackRes.headers.get("Location") ?? "";
  expect(callbackLocation).toContain("code=");
  const callbackLocationUrl = new URL(callbackLocation);
  const code = callbackLocationUrl.searchParams.get("code");
  expect(code).toBeTruthy();

  // Step 6: Exchange code for token
  const tokenFormData = new URLSearchParams();
  tokenFormData.set("grant_type", "authorization_code");
  tokenFormData.set("code", code!);
  tokenFormData.set("redirect_uri", "https://test.local/callback");
  tokenFormData.set("client_id", clientId);
  tokenFormData.set("code_verifier", codeVerifier);

  const tokenRes = await doFetch(
    "/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenFormData.toString(),
    },
    env,
  );

  expect(tokenRes.status).toBe(200);
  const tokenData: any = await tokenRes.json();
  expect(tokenData.access_token).toBeTruthy();

  // Step 7: Use access token to call MCP list_channels
  const mcpRes = await doFetch(
    "/mcp",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${tokenData.access_token}`,
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
});

test.skipIf(config.isRemote)("C6: Admin revoke invalidates access token via OIDC flow (local only)", async () => {
  const env = makeOidcEnv();
  env.ENABLE_CLIENT_BOOTSTRAP = "1";

  // Step 1-5: Get access token via OIDC (same as C5)
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

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const authorizeRes = await doFetch(
    `/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(
      "https://test.local/callback"
    )}&response_type=code&state=s2&code_challenge=${codeChallenge}&code_challenge_method=S256&scope=dovecote:notify`,
    undefined,
    env,
  );

  expect(authorizeRes.status).toBe(302);

  const upstreamLoc = authorizeRes.headers.get("Location") ?? "";
  const upstreamParams = new URL(upstreamLoc).searchParams;
  const signedState = upstreamParams.get("state") ?? "";

  const decoded = await decodeOidcState(signedState, STATE_SECRET);
  expect(decoded).not.toBeNull();
  capturedNonce = decoded!.nonce ?? "";

  const callbackRes = await doFetch(
    `/oidc/callback?code=upstream-code-revoke&state=${encodeURIComponent(signedState)}`,
    undefined,
    env,
  );
  expect(callbackRes.status).toBe(302);

  const callbackLocation = callbackRes.headers.get("Location") ?? "";
  const callbackLocationUrl = new URL(callbackLocation);
  const code = callbackLocationUrl.searchParams.get("code")!;

  const tokenFormData = new URLSearchParams();
  tokenFormData.set("grant_type", "authorization_code");
  tokenFormData.set("code", code);
  tokenFormData.set("redirect_uri", "https://test.local/callback");
  tokenFormData.set("client_id", clientId);
  tokenFormData.set("code_verifier", codeVerifier);

  const tokenRes = await doFetch(
    "/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenFormData.toString(),
    },
    env,
  );

  const tokenData: any = await tokenRes.json();
  const accessToken = tokenData.access_token;

  // Extract grantId from access token (format: {userId}:{grantId}:{tokenSecret})
  const tokenParts = accessToken.split(":");
  expect(tokenParts.length).toBeGreaterThanOrEqual(2);
  const grantId = tokenParts[1];

  if (!grantId) {
    console.warn("Could not extract grantId from access token, skipping C6 revoke test");
    return;
  }

  // The OIDC user is auto-provisioned as normalized subject ("alice")
  const userId = "alice";

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
