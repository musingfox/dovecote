/**
 * C9: Miniflare /mcp endpoint integration test — OIDC flow.
 *
 * Verifies:
 *   - POST /mcp with valid access_token → 200 + JSON-RPC result containing
 *     `tools/list` with `send_notification`
 *   - POST /mcp without token → 401
 */

import { beforeAll, afterAll, test, expect } from "bun:test";
import * as jose from "jose";
import { initMiniflare, disposeMiniflare, getMiniflare } from "./setup.js";
import { generateCodeVerifier, generateCodeChallenge } from "../../helpers/pkce.js";
import { decodeOidcState } from "../../../src/auth/oidc-rp-state.js";

const STATE_SECRET = "miniflare-mcp-oidc-state-secret-32!";
const SUBJECT = "test-user-c9";

let kp: jose.GenerateKeyPairResult;
let pubJwk: jose.JWK;
let idp: ReturnType<typeof Bun.serve>;
let idpBase: string;

// Closure variable: current id_token to return from fake /token
let currentIdToken = "";

let accessToken: string;

beforeAll(async () => {
  // Generate RSA key pair for signing id_tokens
  kp = await jose.generateKeyPair("RS256", { extractable: true });
  pubJwk = await jose.exportJWK(kp.publicKey);
  pubJwk.kid = "c9-kid";
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
      audience: "rp-client-c9",
      client_id: "rp-client-c9",
      authorization_endpoint: `${idpBase}/authorize`,
      token_endpoint: `${idpBase}/token`,
    },
  ]);

  await initMiniflare({
    OIDC_STATE_SECRET: STATE_SECRET,
    OIDC_ISSUERS: oidcIssuers,
  });

  accessToken = await obtainAccessToken();
}, 60_000);

afterAll(async () => {
  await disposeMiniflare();
  idp.stop(true);
});

// ── helper: run full OIDC flow to get a dovecote access token ─────────────────
async function obtainAccessToken(): Promise<string> {
  const mf = getMiniflare();

  // Bootstrap client
  const bootstrapRes = await mf.dispatchFetch(
    "https://example.com/admin/bootstrap-client",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer admin-token-123",
      },
      body: JSON.stringify({
        clientName: "mcp-test-client-c9",
        redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
      }),
    },
  );
  const { client_id: clientId } = (await bootstrapRes.json()) as {
    client_id: string;
  };

  // PKCE
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  // GET /authorize → 302
  const authorizeUrl = new URL("https://example.com/authorize");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", "https://claude.ai/api/mcp/auth_callback");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", "mcp-state-c9");
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("scope", "dovecote:notify");

  const authorizeRes = await mf.dispatchFetch(authorizeUrl.toString(), {
    redirect: "manual",
  });
  const upstreamLoc = authorizeRes.headers.get("location") ?? "";

  // Decode signed state to get nonce
  const signedState = new URL(upstreamLoc).searchParams.get("state") ?? "";
  const decoded = await decodeOidcState(signedState, STATE_SECRET);
  const nonce = decoded!.nonce;

  // Sign id_token with nonce, set closure var
  const now = Math.floor(Date.now() / 1000);
  currentIdToken = await new jose.SignJWT({ nonce })
    .setProtectedHeader({ alg: "RS256", kid: "c9-kid" })
    .setIssuer(idpBase)
    .setAudience("rp-client-c9")
    .setSubject(SUBJECT)
    .setIssuedAt(now - 10)
    .setExpirationTime(now + 3600)
    .sign(kp.privateKey);

  // GET /oidc/callback
  const callbackUrl = new URL("https://example.com/oidc/callback");
  callbackUrl.searchParams.set("code", "upstream-code-c9");
  callbackUrl.searchParams.set("state", signedState);

  const callbackRes = await mf.dispatchFetch(callbackUrl.toString(), {
    redirect: "manual",
  });
  const callbackLocation = callbackRes.headers.get("location") ?? "";
  const code = new URL(callbackLocation).searchParams.get("code")!;

  // POST /token
  const tokenParams = new URLSearchParams();
  tokenParams.set("grant_type", "authorization_code");
  tokenParams.set("code", code);
  tokenParams.set("redirect_uri", "https://claude.ai/api/mcp/auth_callback");
  tokenParams.set("client_id", clientId);
  tokenParams.set("code_verifier", codeVerifier);

  const tokenRes = await mf.dispatchFetch("https://example.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenParams.toString(),
  });

  const { access_token } = (await tokenRes.json()) as { access_token: string };
  return access_token;
}

// ── tests ─────────────────────────────────────────────────────────────────────

test("C9: POST /mcp without token returns 401", async () => {
  const mf = getMiniflare();

  const res = await mf.dispatchFetch("https://example.com/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    }),
  });

  expect(res.status).toBe(401);
});

test("C9: POST /mcp tools/list with valid token returns send_notification tool", async () => {
  const mf = getMiniflare();

  const res = await mf.dispatchFetch("https://example.com/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    }),
  });

  expect(res.status).toBe(200);

  const text = await res.text();

  // Response is SSE (text/event-stream): find the first data: line
  let resultJson: any;
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  if (dataLine) {
    resultJson = JSON.parse(dataLine.slice("data:".length).trim());
  } else {
    resultJson = JSON.parse(text);
  }

  // tools/list result shape: { result: { tools: [...] } }
  const tools: Array<{ name: string }> = resultJson?.result?.tools ?? [];
  const toolNames = tools.map((t) => t.name);
  expect(toolNames).toContain("send_notification");
});
