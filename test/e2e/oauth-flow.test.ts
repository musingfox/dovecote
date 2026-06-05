import { test, expect, beforeAll, afterAll } from "bun:test";
import * as jose from "jose";
import type { Env } from "../../src/types.js";
import app from "../../src/index.js";
import { createMockExecutionCtx } from "../helpers/mock-execution-ctx.js";
import { generateCodeVerifier, generateCodeChallenge } from "../helpers/pkce.js";
import { MockKV } from "../helpers/mock-kv.js";
import { decodeOidcState } from "../../src/auth/oidc-rp-state.js";

// ---- OIDC upstream mock config ------------------------------------------------

const ISSUER = "https://idp.e2e-test.example";
const AUDIENCE = "rp-client-e2e";
const RP_CLIENT_ID = "rp-client-e2e";
const TOKEN_ENDPOINT = `${ISSUER}/token`;
const JWKS_URI = `${ISSUER}/jwks`;
const STATE_SECRET = "e2e-state-secret-32-chars-minimum!";
const SUBJECT = "alice";

let kp: jose.GenerateKeyPairResult;
let pubJwk: jose.JWK;
const originalFetch = globalThis.fetch;

// nonce captured from each test's authorize redirect — must match id_token
let capturedNonce = "";

beforeAll(async () => {
  kp = await jose.generateKeyPair("RS256", { extractable: true });
  pubJwk = await jose.exportJWK(kp.publicKey);
  pubJwk.kid = "e2e-kid";
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
        .setProtectedHeader({ alg: "RS256", kid: "e2e-kid" })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setSubject(SUBJECT)
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

// ---- env with OIDC config -----------------------------------------------------

function makeOidcEnv(): Env {
  return {
    OAUTH_KV: new MockKV() as any,
    OAUTH_PASSWORD: "test-password",
    COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length-required",
    HMAC_PEPPER: "test-pepper",
    TELEGRAM_INSTANCES: undefined,
    DISCORD_INSTANCES: undefined,
    ADMIN_REVOKE_TOKEN: "admin-token-123",
    ENABLE_CLIENT_BOOTSTRAP: "1",
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

test("GET /.well-known/oauth-authorization-server returns metadata", async () => {
  const env = makeOidcEnv();
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
  const env = makeOidcEnv();
  const req = new Request("https://example.com/.well-known/oauth-protected-resource");
  const res = await app.fetch(req, env, createMockExecutionCtx() as any);

  expect(res.status).toBe(200);

  const json = await res.json() as { resource: string };
  expect(json.resource).toBeTruthy();
});

test("POST /mcp without Authorization returns 401", async () => {
  const env = makeOidcEnv();
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

test("Full OAuth flow via OIDC: Bootstrap -> Authorize(OIDC) -> Callback -> Token -> API access", async () => {
  const env = makeOidcEnv();

  // Step 1: Bootstrap client
  const bootstrapRes = await app.fetch(
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
    env,
    createMockExecutionCtx() as any,
  );
  expect(bootstrapRes.status).toBe(200);

  const clientInfo = await bootstrapRes.json() as { client_id: string };
  expect(clientInfo.client_id).toBeTruthy();
  const clientId = clientInfo.client_id;

  // Step 2: Generate PKCE
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  // Step 3: GET /authorize → now returns 302 OIDC redirect
  const authorizeUrl = new URL("https://example.com/authorize");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", "https://claude.ai/api/mcp/auth_callback");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", "s1");
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("scope", "dovecote:notify");

  const authorizeGetRes = await app.fetch(
    new Request(authorizeUrl.toString()),
    env,
    createMockExecutionCtx() as any,
  );
  expect(authorizeGetRes.status).toBe(302);

  const upstreamLoc = authorizeGetRes.headers.get("Location") ?? "";
  expect(upstreamLoc.startsWith(`${ISSUER}/authorize`)).toBe(true);

  // Step 4: Extract state and nonce from the upstream redirect Location
  const upstreamParams = new URL(upstreamLoc).searchParams;
  const signedState = upstreamParams.get("state") ?? "";
  expect(signedState.length).toBeGreaterThan(0);

  // Decode state to get nonce (needed to match id_token nonce)
  const decoded = await decodeOidcState(signedState, STATE_SECRET);
  expect(decoded).not.toBeNull();
  capturedNonce = decoded!.nonce ?? "";
  expect(capturedNonce.length).toBeGreaterThan(0);

  // Step 5: Simulate IdP callback → GET /oidc/callback
  const callbackUrl = new URL("https://example.com/oidc/callback");
  callbackUrl.searchParams.set("code", "upstream-auth-code");
  callbackUrl.searchParams.set("state", signedState);

  const callbackRes = await app.fetch(
    new Request(callbackUrl.toString()),
    env,
    createMockExecutionCtx() as any,
  );
  expect(callbackRes.status).toBe(302);

  const callbackLocation = callbackRes.headers.get("Location") ?? "";
  expect(callbackLocation).toContain("code=");

  // Step 6: Extract authorization code from callback redirect
  const callbackLocationUrl = new URL(callbackLocation);
  const code = callbackLocationUrl.searchParams.get("code");
  expect(code).toBeTruthy();

  // Step 7: Exchange code for token
  const tokenFormData = new URLSearchParams();
  tokenFormData.set("grant_type", "authorization_code");
  tokenFormData.set("code", code!);
  tokenFormData.set("redirect_uri", "https://claude.ai/api/mcp/auth_callback");
  tokenFormData.set("client_id", clientId);
  tokenFormData.set("code_verifier", codeVerifier);

  const tokenRes = await app.fetch(
    new Request("https://example.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenFormData.toString(),
    }),
    env,
    createMockExecutionCtx() as any,
  );
  expect(tokenRes.status).toBe(200);

  const tokenData = await tokenRes.json() as {
    access_token: string;
    refresh_token: string;
    token_type: string;
  };
  expect(tokenData.access_token).toBeTruthy();
  expect(tokenData.refresh_token).toBeTruthy();
  expect(tokenData.token_type.toLowerCase()).toBe("bearer");

  // Step 8: Use access token to call MCP API
  const mcpRes = await app.fetch(
    new Request("https://example.com/mcp", {
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
    }),
    env,
    createMockExecutionCtx() as any,
  );
  expect(mcpRes.status).toBe(200);

  const mcpText = await mcpRes.text();
  expect(mcpText).toContain("dovecote-mcp-server");
});
