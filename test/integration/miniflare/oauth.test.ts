/**
 * C8: Miniflare OAuth boundary integration test — M1 token-paste form flow.
 *
 * Verifies the full PKCE OAuth flow runs inside a real workerd boundary
 * (wrangler-built bundle loaded by Miniflare):
 *   bootstrap → GET /authorize (200 form, PKCE hidden fields) →
 *   POST /authorize with a pasted dvct_* token (302 + code) →
 *   token exchange → KV stores the token
 */

import { beforeAll, afterAll, test, expect } from "bun:test";
import {
  initMiniflare,
  disposeMiniflare,
  getMiniflare,
  seedDvctToken,
} from "./setup.js";
import { generateCodeVerifier, generateCodeChallenge } from "../../helpers/pkce.js";

const USER_ID = "test-user-c8";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

beforeAll(async () => {
  await initMiniflare();
}, 30_000);

afterAll(async () => {
  await disposeMiniflare();
});

test("C8: bootstrap → authorize form → POST dvct token → token → KV non-null", async () => {
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
        clientName: "integration-test-client-c8",
        redirectUris: [REDIRECT_URI],
      }),
    },
  );

  expect(bootstrapRes.status).toBe(200);
  const clientInfo = (await bootstrapRes.json()) as { client_id: string };
  expect(clientInfo.client_id).toBeTruthy();
  const clientId = clientInfo.client_id;

  // ── Step 2: Seed a dvct_* root token + PKCE ────────────────────────────────
  const { token: dvctToken } = await seedDvctToken({
    userId: USER_ID,
    scopes: ["dovecote:notify"],
  });
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const oauthParams = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    state: "integration-state-c8",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    scope: "dovecote:notify",
  });

  // ── Step 3: GET /authorize → 200 token-paste form with PKCE hidden fields ──
  const formRes = await mf.dispatchFetch(
    `https://example.com/authorize?${oauthParams}`,
    { redirect: "manual" },
  );
  expect(formRes.status).toBe(200);
  const formHtml = await formRes.text();
  expect(formHtml).toContain('name="token"');
  expect(formHtml).toContain(`name="code_challenge" value="${codeChallenge}"`);
  expect(formHtml).toContain('name="code_challenge_method" value="S256"');

  // ── Step 4: POST /authorize with the pasted token → 302 + code ─────────────
  const postBody = new URLSearchParams(oauthParams);
  postBody.set("token", dvctToken);
  const postRes = await mf.dispatchFetch("https://example.com/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: postBody.toString(),
    redirect: "manual",
  });
  expect(postRes.status).toBe(302);

  const location = postRes.headers.get("location") ?? "";
  expect(location.startsWith(REDIRECT_URI)).toBe(true);
  const locationUrl = new URL(location);
  expect(locationUrl.searchParams.get("state")).toBe("integration-state-c8");
  const code = locationUrl.searchParams.get("code");
  expect(code).toBeTruthy();

  // ── Step 5: Exchange code for dovecote access token (PKCE verifier) ────────
  const tokenParams = new URLSearchParams();
  tokenParams.set("grant_type", "authorization_code");
  tokenParams.set("code", code!);
  tokenParams.set("redirect_uri", REDIRECT_URI);
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
    token_type: string;
  };
  expect(tokenData.access_token).toBeTruthy();
  expect(tokenData.token_type.toLowerCase()).toBe("bearer");

  // ── Step 6: KV should contain the token ────────────────────────────────────
  const kv = await mf.getKVNamespace("OAUTH_KV");
  const keys = await kv.list({ prefix: "token:" });
  expect(keys.keys.length).toBeGreaterThan(0);
});

test("C8: POST /authorize with an invalid token re-renders the form 401 and issues no code", async () => {
  const mf = getMiniflare();

  const bootstrapRes = await mf.dispatchFetch(
    "https://example.com/admin/bootstrap-client",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer admin-token-123",
      },
      body: JSON.stringify({
        clientName: "integration-test-client-c8-reject",
        redirectUris: [REDIRECT_URI],
      }),
    },
  );
  const { client_id: clientId } = (await bootstrapRes.json()) as {
    client_id: string;
  };

  const codeChallenge = await generateCodeChallenge(generateCodeVerifier());
  const body = new URLSearchParams({
    token: "dvct_definitely-not-a-real-token",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    state: "reject-state",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    scope: "dovecote:notify",
  });
  const res = await mf.dispatchFetch("https://example.com/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    redirect: "manual",
  });
  expect(res.status).toBe(401);
  const html = await res.text();
  expect(html).toContain('name="token"');
  expect(html).toContain("Invalid token");
});
