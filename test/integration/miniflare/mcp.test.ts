/**
 * C9: Miniflare /mcp endpoint integration test.
 *
 * Verifies:
 *   - POST /mcp with valid access_token → 200 + JSON-RPC result containing
 *     `tools/list` with `send-notification`
 *   - POST /mcp without token → 401
 */

import { beforeAll, afterAll, test, expect } from "bun:test";
import { initMiniflare, disposeMiniflare, getMiniflare } from "./setup.js";
import { generateCodeVerifier, generateCodeChallenge } from "../../helpers/pkce.js";

let accessToken: string;

beforeAll(async () => {
  await initMiniflare();
  accessToken = await obtainAccessToken();
}, 60_000);

afterAll(async () => {
  await disposeMiniflare();
});

// ── helper: run full OAuth flow to get a token ────────────────────────────────
async function obtainAccessToken(): Promise<string> {
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
        clientName: "mcp-test-client",
        redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
      }),
    },
  );
  const { client_id: clientId } = (await bootstrapRes.json()) as {
    client_id: string;
  };

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const authorizeUrl = new URL("https://example.com/authorize");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set(
    "redirect_uri",
    "https://claude.ai/api/mcp/auth_callback",
  );
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", "mcp-state-1");
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("scope", "dovecote:notify");

  const authorizeGetRes = await mf.dispatchFetch(authorizeUrl.toString());
  const html = await authorizeGetRes.text();
  const csrfToken = html.match(/name="csrf_token" value="([^"]+)"/)![1]!;
  const cookieValue = authorizeGetRes.headers
    .get("set-cookie")!
    .match(/csrf=([^;]+)/)![1]!;

  const authorizeFormData = new URLSearchParams();
  authorizeFormData.set("csrf_token", csrfToken);
  authorizeFormData.set("password", "test-password");
  authorizeFormData.set("response_type", "code");
  authorizeFormData.set("client_id", clientId);
  authorizeFormData.set(
    "redirect_uri",
    "https://claude.ai/api/mcp/auth_callback",
  );
  authorizeFormData.set("state", "mcp-state-1");
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

  const location = authorizePostRes.headers.get("location")!;
  const code = new URL(location).searchParams.get("code")!;

  const tokenParams = new URLSearchParams();
  tokenParams.set("grant_type", "authorization_code");
  tokenParams.set("code", code);
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

  const { access_token } = (await tokenRes.json()) as {
    access_token: string;
  };
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

test("C9: POST /mcp tools/list with valid token returns send-notification tool", async () => {
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
  // Format: "event: message\ndata: <json>\n\n"
  let resultJson: any;
  const dataLine = text
    .split("\n")
    .find((l) => l.startsWith("data:"));
  if (dataLine) {
    resultJson = JSON.parse(dataLine.slice("data:".length).trim());
  } else {
    resultJson = JSON.parse(text);
  }

  // tools/list result shape: { result: { tools: [...] } }
  const tools: Array<{ name: string }> = resultJson?.result?.tools ?? [];
  const toolNames = tools.map((t) => t.name);
  // The tool is registered as "send_notification" (underscore)
  expect(toolNames).toContain("send_notification");
});
