/**
 * C8: Miniflare OAuth boundary integration test — OIDC flow.
 *
 * Verifies the full PKCE OAuth flow via OIDC runs inside a real workerd boundary
 * (wrangler-built bundle loaded by Miniflare):
 *   bootstrap → authorize GET (302) → OIDC callback → token exchange
 *   → KV stores the token
 */

import { beforeAll, afterAll, test, expect } from "bun:test";
import * as jose from "jose";
import { initMiniflare, disposeMiniflare, getMiniflare } from "./setup.js";
import { generateCodeVerifier, generateCodeChallenge } from "../../helpers/pkce.js";
// (removed) import { decodeOidcState } from "../../../src/auth/oidc-rp-state.js";

const STATE_SECRET = "miniflare-oidc-state-secret-32ch!";
const SUBJECT = "test-user-c8";

let kp: jose.GenerateKeyPairResult;
let pubJwk: jose.JWK;
let idp: ReturnType<typeof Bun.serve>;
let idpBase: string;

// Closure variable: the current id_token to return from fake /token
let currentIdToken = "";

beforeAll(async () => {
  // Generate RSA key pair for signing id_tokens
  kp = await jose.generateKeyPair("RS256", { extractable: true });
  pubJwk = await jose.exportJWK(kp.publicKey);
  pubJwk.kid = "c8-kid";
  pubJwk.alg = "RS256";
  pubJwk.use = "sig";

  // Start local fake IdP — workerd can reach localhost outbound
  idp = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/token") {
        return new Response(
          JSON.stringify({ id_token: currentIdToken }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.pathname === "/jwks") {
        return new Response(
          JSON.stringify({ keys: [pubJwk] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  idpBase = `http://localhost:${idp.port}`;

  const oidcIssuers = JSON.stringify([
    {
      issuer: idpBase,
      jwks_uri: `${idpBase}/jwks`,
      audience: "rp-client-c8",
      client_id: "rp-client-c8",
      authorization_endpoint: `${idpBase}/authorize`,
      token_endpoint: `${idpBase}/token`,
    },
  ]);

  await initMiniflare({
    OIDC_STATE_SECRET: STATE_SECRET,
    OIDC_ISSUERS: oidcIssuers,
  });
}, 30_000);

afterAll(async () => {
  await disposeMiniflare();
  idp.stop(true);
});

test("C8: bootstrap → authorize(OIDC) → callback → token → KV non-null", async () => {
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

  // ── Step 3: GET /authorize → 302 OIDC redirect ────────────────────────────
  const authorizeUrl = new URL("https://example.com/authorize");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", "https://claude.ai/api/mcp/auth_callback");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", "integration-state-c8");
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("scope", "dovecote:notify");

  const authorizeRes = await mf.dispatchFetch(authorizeUrl.toString(), {
    redirect: "manual",
  });
  expect(authorizeRes.status).toBe(302);

  const upstreamLoc = authorizeRes.headers.get("location") ?? "";
  expect(upstreamLoc.startsWith(`${idpBase}/authorize`)).toBe(true);

  // ── Step 4: Extract signed state, decode nonce ────────────────────────────
  const upstreamParams = new URL(upstreamLoc).searchParams;
  const signedState = upstreamParams.get("state") ?? "";
  expect(signedState.length).toBeGreaterThan(0);

  const decoded = await decodeOidcState(signedState, STATE_SECRET);
  expect(decoded).not.toBeNull();
  const nonce = decoded!.nonce;
  expect(nonce.length).toBeGreaterThan(0);

  // ── Step 5: Sign id_token with nonce, set closure var ────────────────────
  const now = Math.floor(Date.now() / 1000);
  currentIdToken = await new jose.SignJWT({ nonce })
    .setProtectedHeader({ alg: "RS256", kid: "c8-kid" })
    .setIssuer(idpBase)
    .setAudience("rp-client-c8")
    .setSubject(SUBJECT)
    .setIssuedAt(now - 10)
    .setExpirationTime(now + 3600)
    .sign(kp.privateKey);

  // ── Step 6: Simulate IdP callback ─────────────────────────────────────────
  const callbackUrl = new URL("https://example.com/oidc/callback");
  callbackUrl.searchParams.set("code", "upstream-code-c8");
  callbackUrl.searchParams.set("state", signedState);

  const callbackRes = await mf.dispatchFetch(callbackUrl.toString(), {
    redirect: "manual",
  });
  expect(callbackRes.status).toBe(302);

  const callbackLocation = callbackRes.headers.get("location") ?? "";
  expect(callbackLocation).toContain("code=");

  // ── Step 7: Extract auth code + verify client state round-trip ──────────
  expect(new URL(callbackLocation).searchParams.get("state")).toBe("integration-state-c8");
  const code = new URL(callbackLocation).searchParams.get("code");
  expect(code).toBeTruthy();

  // ── Step 8: Exchange code for dovecote access token ───────────────────────
  const tokenParams = new URLSearchParams();
  tokenParams.set("grant_type", "authorization_code");
  tokenParams.set("code", code!);
  tokenParams.set("redirect_uri", "https://claude.ai/api/mcp/auth_callback");
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

  // ── Step 9: KV should contain the token ──────────────────────────────────
  const kv = await mf.getKVNamespace("OAUTH_KV");
  const keys = await kv.list({ prefix: "token:" });
  expect(keys.keys.length).toBeGreaterThan(0);
});
