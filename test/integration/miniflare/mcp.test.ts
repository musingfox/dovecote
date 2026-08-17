/**
 * C9: Miniflare /mcp endpoint integration test — M1 token-paste form flow.
 *
 * Verifies:
 *   - POST /mcp with a valid access_token → 200 + JSON-RPC result containing
 *     `tools/list` with `send_notification`
 *   - tools/call list_channels is NOT Forbidden → the grant props carried a
 *     real identity + scopes through /authorize → /token → /mcp (the AuthCtx
 *     is non-anonymous)
 *   - POST /mcp without token → 401
 */

import { beforeAll, afterAll, test, expect } from "bun:test";
import {
  initMiniflare,
  disposeMiniflare,
  getMiniflare,
  seedDvctToken,
} from "./setup.js";
import { generateCodeVerifier, generateCodeChallenge } from "../../helpers/pkce.js";

const USER_ID = "test-user-c9";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

let accessToken: string;

beforeAll(async () => {
  await initMiniflare();
  // Channels live in KV under their canonical key, not in a worker binding.
  const kv = await getMiniflare().getKVNamespace("OAUTH_KV");
  await kv.put(
    "channel:telegram-c9",
    JSON.stringify({
      service: "telegram",
      id: "c9",
      botToken: "fake:token",
      chatId: "123",
    }),
  );
  accessToken = await obtainAccessToken();
}, 60_000);

afterAll(async () => {
  await disposeMiniflare();
});

// ── helper: run the full form flow to get a dovecote access token ─────────────
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
        redirectUris: [REDIRECT_URI],
      }),
    },
  );
  const { client_id: clientId } = (await bootstrapRes.json()) as {
    client_id: string;
  };

  // Seed root credential + PKCE
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
    state: "mcp-state-c9",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    scope: "dovecote:notify",
  });

  // GET /authorize → 200 form
  const formRes = await mf.dispatchFetch(
    `https://example.com/authorize?${oauthParams}`,
    { redirect: "manual" },
  );
  if (formRes.status !== 200) {
    throw new Error(`GET /authorize returned ${formRes.status}`);
  }

  // POST /authorize with the pasted token → 302 + code
  const postBody = new URLSearchParams(oauthParams);
  postBody.set("token", dvctToken);
  const postRes = await mf.dispatchFetch("https://example.com/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: postBody.toString(),
    redirect: "manual",
  });
  const location = postRes.headers.get("location") ?? "";
  const code = new URL(location).searchParams.get("code")!;

  // POST /token
  const tokenParams = new URLSearchParams();
  tokenParams.set("grant_type", "authorization_code");
  tokenParams.set("code", code);
  tokenParams.set("redirect_uri", REDIRECT_URI);
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

function parseMcpBody(text: string): any {
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  if (dataLine) {
    return JSON.parse(dataLine.slice("data:".length).trim());
  }
  return JSON.parse(text);
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

  const resultJson = parseMcpBody(await res.text());

  // tools/list result shape: { result: { tools: [...] } }
  const tools: Array<{ name: string }> = resultJson?.result?.tools ?? [];
  const toolNames = tools.map((t) => t.name);
  expect(toolNames).toContain("send_notification");
});

test("C9: tools/call list_channels with the form-flow token is NOT Forbidden (AuthCtx is non-anonymous)", async () => {
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
      id: 2,
      method: "tools/call",
      params: { name: "list_channels", arguments: {} },
    }),
  });

  expect(res.status).toBe(200);
  const resultJson = parseMcpBody(await res.text());
  expect(resultJson.result).toBeTruthy();
  const text: string = resultJson.result.content[0].text;
  // ANONYMOUS (props dropped) would yield "Forbidden: missing scope …"
  expect(text).not.toMatch(/Forbidden/);
  expect(resultJson.result.isError).toBeUndefined();
  // scope carried → the seeded telegram channel is visible
  const channels = JSON.parse(text) as Array<{ id: string }>;
  expect(channels.map((c) => c.id)).toContain("telegram-c9");
});

test("C9: tools/call send_notification resolves the KV-seeded channel (not Unknown channel)", async () => {
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
      id: 3,
      method: "tools/call",
      params: {
        name: "send_notification",
        arguments: { channel: "telegram-c9", content: { text: "hi" } },
      },
    }),
  });

  expect(res.status).toBe(200);
  const resultJson = parseMcpBody(await res.text());
  const text: string = resultJson.result.content[0].text;
  // The outbound Telegram call fails in Miniflare; what matters is that the
  // channel itself resolved from KV.
  expect(text).not.toContain("Unknown channel");
});
