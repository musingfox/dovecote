/**
 * C8: Miniflare OAuth boundary integration test.
 *
 * Verifies the full PKCE OAuth flow runs inside a real workerd boundary
 * (wrangler-built bundle loaded by Miniflare):
 *   bootstrap → authorize GET → authorize POST (302 + code) → token exchange
 *   → KV stores the token
 */

import { beforeAll, afterAll, test, expect } from "bun:test";
import { initMiniflare, disposeMiniflare, getMiniflare } from "./setup.js";
import { generateCodeVerifier, generateCodeChallenge } from "../../helpers/pkce.js";

beforeAll(async () => {
  await initMiniflare();
}, 30_000);

afterAll(async () => {
  await disposeMiniflare();
});

test("C8: bootstrap → authorize → token → KV non-null", async () => {
  const mf = getMiniflare();

  // ── Step 1: Bootstrap client via admin endpoint ────────────────────────────
  const bootstrapRes = await mf.dispatchFetch(
    "https://example.com/admin/bootstrap-client",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer admin-token-123",
      },
      body: JSON.stringify({
        clientName: "integration-test-client",
        redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
      }),
    },
  );

  expect(bootstrapRes.status).toBe(200);
  const clientInfo = (await bootstrapRes.json()) as { client_id: string };
  expect(clientInfo.client_id).toBeTruthy();
  const clientId = clientInfo.client_id;

  // ── Step 2: PKCE ───────────────────────────────────────────────────────────
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  // ── Step 3: GET /authorize — obtain CSRF token + cookie ───────────────────
  const authorizeUrl = new URL("https://example.com/authorize");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set(
    "redirect_uri",
    "https://claude.ai/api/mcp/auth_callback",
  );
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", "integration-state-1");
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("scope", "dovecote:notify");

  const authorizeGetRes = await mf.dispatchFetch(authorizeUrl.toString());
  expect(authorizeGetRes.status).toBe(200);

  const html = await authorizeGetRes.text();
  const csrfMatch = html.match(/name="csrf_token" value="([^"]+)"/);
  expect(csrfMatch).toBeTruthy();
  const csrfToken = csrfMatch![1]!;

  const setCookie = authorizeGetRes.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  const cookieMatch = setCookie!.match(/csrf=([^;]+)/);
  expect(cookieMatch).toBeTruthy();
  const cookieValue = cookieMatch![1];

  // ── Step 4: POST /authorize — submit password → expect 302 + code ─────────
  const authorizeFormData = new URLSearchParams();
  authorizeFormData.set("csrf_token", csrfToken);
  authorizeFormData.set("password", "test-password");
  authorizeFormData.set("response_type", "code");
  authorizeFormData.set("client_id", clientId);
  authorizeFormData.set(
    "redirect_uri",
    "https://claude.ai/api/mcp/auth_callback",
  );
  authorizeFormData.set("state", "integration-state-1");
  authorizeFormData.set("scope", "dovecote:notify");
  authorizeFormData.set("code_challenge", codeChallenge);
  authorizeFormData.set("code_challenge_method", "S256");

  const authorizePostRes = await mf.dispatchFetch(
    "https://example.com/authorize",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `csrf=${cookieValue}`,
      },
      body: authorizeFormData.toString(),
      redirect: "manual",
    },
  );

  expect(authorizePostRes.status).toBe(302);

  const location = authorizePostRes.headers.get("location");
  expect(location).toBeTruthy();
  expect(location).toContain("code=");
  expect(location).toContain("state=integration-state-1");

  const locationUrl = new URL(location!);
  const code = locationUrl.searchParams.get("code");
  expect(code).toBeTruthy();

  // ── Step 5: Exchange code for token ───────────────────────────────────────
  const tokenParams = new URLSearchParams();
  tokenParams.set("grant_type", "authorization_code");
  tokenParams.set("code", code!);
  tokenParams.set(
    "redirect_uri",
    "https://claude.ai/api/mcp/auth_callback",
  );
  tokenParams.set("client_id", clientId);
  tokenParams.set("code_verifier", codeVerifier);

  const tokenRes = await mf.dispatchFetch("https://example.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenParams.toString(),
  });

  expect(tokenRes.status).toBe(200);
  const tokenData = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
    token_type: string;
  };
  expect(tokenData.access_token).toBeTruthy();
  expect(tokenData.token_type.toLowerCase()).toBe("bearer");

  // ── Step 6: KV should contain the token ───────────────────────────────────
  const kv = await mf.getKVNamespace("OAUTH_KV");
  const keys = await kv.list({ prefix: "token:" });
  expect(keys.keys.length).toBeGreaterThan(0);
});
