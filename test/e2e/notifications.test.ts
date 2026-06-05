import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as jose from "jose";
import app from "../../src/index";
import apiApp from "../../src/api";
import type { Env } from "../../src/types";
import type { ExecutionContext } from "@cloudflare/workers-types";
import { config } from "./config";
import { MockKV } from "../helpers/mock-kv";
import { decodeOidcState } from "../../src/auth/oidc-rp-state";
import { generateCodeVerifier, generateCodeChallenge } from "../helpers/pkce";

// ── OIDC mock config ──────────────────────────────────────────────────────────

const ISSUER = "https://idp.notifications-test.example";
const AUDIENCE = "rp-client-notifications";
const RP_CLIENT_ID = "rp-client-notifications";
const TOKEN_ENDPOINT = `${ISSUER}/token`;
const JWKS_URI = `${ISSUER}/jwks`;
const STATE_SECRET = "notifications-oidc-state-secret-32!";
const SUBJECT = "notif-test-user";

let kp: jose.GenerateKeyPairResult;
let pubJwk: jose.JWK;
const originalFetch = globalThis.fetch;

// Nonce captured per flow
let capturedNonce = "";

beforeAll(async () => {
  kp = await jose.generateKeyPair("RS256", { extractable: true });
  pubJwk = await jose.exportJWK(kp.publicKey);
  pubJwk.kid = "notif-kid";
  pubJwk.alg = "RS256";
  pubJwk.use = "sig";

  // Override globalThis.fetch to intercept OIDC token + JWKS requests
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
        .setProtectedHeader({ alg: "RS256", kid: "notif-kid" })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setSubject(SUBJECT)
        .setIssuedAt(now - 10)
        .setExpirationTime(now + 3600)
        .sign(kp.privateKey);
      return new Response(JSON.stringify({ id_token: idToken }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url === JWKS_URI || url.startsWith(JWKS_URI + "?")) {
      return new Response(JSON.stringify({ keys: [pubJwk] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return originalFetch(input as any, init);
  };

  // Inject OIDC config into config.env so doFetch shares the same KV
  (config.env as any).OIDC_STATE_SECRET = STATE_SECRET;
  (config.env as any).OIDC_ISSUERS = JSON.stringify([
    {
      issuer: ISSUER,
      jwks_uri: JWKS_URI,
      audience: AUDIENCE,
      client_id: RP_CLIENT_ID,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: TOKEN_ENDPOINT,
    },
  ]);
});

afterAll(() => {
  (globalThis as any).fetch = originalFetch;
});

const oauthDefaults = {
  OAUTH_KV: new MockKV() as any,
  OAUTH_PASSWORD: "test-password",
  COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length-required",
  HMAC_PEPPER: "test-pepper",
  ADMIN_REVOKE_TOKEN: "admin-test-token",
  ENABLE_CLIENT_BOOTSTRAP: "1",
};

const authenticatedCtx = {
  props: { userId: "test-user", scopes: ["dovecote:notify"] },
  waitUntil: () => {},
  passThroughOnException: () => {},
} as ExecutionContext;

// ── OIDC flow helper ──────────────────────────────────────────────────────────

/**
 * Run full OIDC flow against the in-process app to obtain an access token.
 * Uses config.env (shared KV) and globalThis.fetch override for OIDC endpoints.
 */
async function runOidcFlow(clientId: string, scope: string, stateVal: string): Promise<string> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  // GET /authorize → 302 to fake IdP
  const authorizeUrl = new URL("http://localhost/authorize");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", "https://test.local/callback");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", stateVal);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("scope", scope);

  const authorizeRes = await doFetch(new Request(authorizeUrl.toString()));
  if (authorizeRes.status !== 302) {
    throw new Error(`authorize returned ${authorizeRes.status}: ${await authorizeRes.text()}`);
  }

  const upstreamLoc = authorizeRes.headers.get("Location") ?? "";
  const signedState = new URL(upstreamLoc).searchParams.get("state") ?? "";
  if (!signedState) throw new Error("No state in authorize redirect");

  // Decode state to get nonce for id_token
  const decoded = await decodeOidcState(signedState, STATE_SECRET);
  if (!decoded) throw new Error("Failed to decode OIDC state");
  capturedNonce = decoded.nonce;

  // GET /oidc/callback — simulates user having authenticated at IdP
  const callbackUrl = new URL("http://localhost/oidc/callback");
  callbackUrl.searchParams.set("code", "upstream-code-notif");
  callbackUrl.searchParams.set("state", signedState);

  const callbackRes = await doFetch(new Request(callbackUrl.toString()));
  if (callbackRes.status !== 302) {
    throw new Error(`oidc/callback returned ${callbackRes.status}: ${await callbackRes.text()}`);
  }

  const callbackLocation = callbackRes.headers.get("Location") ?? "";
  const code = new URL(callbackLocation).searchParams.get("code");
  if (!code) throw new Error("No authorization code in callback redirect");

  // POST /token
  const tokenFormData = new URLSearchParams();
  tokenFormData.set("grant_type", "authorization_code");
  tokenFormData.set("code", code);
  tokenFormData.set("redirect_uri", "https://test.local/callback");
  tokenFormData.set("client_id", clientId);
  tokenFormData.set("code_verifier", codeVerifier);

  const tokenReq = new Request("http://localhost/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenFormData.toString(),
  });

  const tokenRes = await doFetch(tokenReq);
  if (tokenRes.status !== 200) {
    throw new Error(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }

  const tokenData = (await tokenRes.json()) as { access_token: string };
  return tokenData.access_token;
}

// Helper to get an OAuth access token for local testing via OIDC flow
let cachedAccessToken: string | null = null;
async function getTestAccessToken(): Promise<string> {
  if (cachedAccessToken) return cachedAccessToken;

  // Bootstrap client
  const bootstrapReq = new Request("http://localhost/admin/bootstrap-client", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer admin-test-token`,
    },
    body: JSON.stringify({
      clientName: "e2e-test-client",
      redirectUris: ["https://test.local/callback"],
    }),
  });

  const bootstrapRes = await doFetch(bootstrapReq);
  if (bootstrapRes.status !== 200) {
    throw new Error(`Bootstrap failed: ${bootstrapRes.status} ${await bootstrapRes.text()}`);
  }

  const clientInfo = (await bootstrapRes.json()) as { client_id: string };
  const clientId = clientInfo.client_id;

  cachedAccessToken = await runOidcFlow(clientId, "dovecote:notify", "test-state");
  return cachedAccessToken;
}

// Cache for narrow-scope tokens, keyed by scope string
const narrowScopeTokenCache = new Map<string, string>();

/**
 * Get an OAuth access token for a specific scope (not the default full-scope token).
 * Uses a separate client registration per scope to avoid token conflicts.
 */
async function getTestAccessTokenForScope(scope: string): Promise<string> {
  const cached = narrowScopeTokenCache.get(scope);
  if (cached) return cached;

  // Bootstrap a separate client for this narrow scope
  const bootstrapReq = new Request("http://localhost/admin/bootstrap-client", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer admin-test-token`,
    },
    body: JSON.stringify({
      clientName: `e2e-test-client-narrow-${scope.replace(/[^a-z0-9]/g, "-")}`,
      redirectUris: ["https://test.local/callback"],
    }),
  });

  const bootstrapRes = await doFetch(bootstrapReq);
  if (bootstrapRes.status !== 200) {
    throw new Error(`Bootstrap failed: ${bootstrapRes.status} ${await bootstrapRes.text()}`);
  }

  const clientInfo = (await bootstrapRes.json()) as { client_id: string };
  const clientId = clientInfo.client_id;

  const token = await runOidcFlow(clientId, scope, "test-state-narrow");
  narrowScopeTokenCache.set(scope, token);
  return token;
}

/**
 * E2E tests — supports both local (in-process) and remote (HTTP) testing.
 *
 * Local mode (default): Requires .dev.vars with valid credentials.
 * Remote mode: Set TEST_BASE_URL and TEST_AUTH_TOKEN environment variables.
 *
 * Run explicitly: bun test test/e2e/
 */

async function doFetch(req: Request): Promise<Response> {
  if (config.isRemote) {
    // Remote mode: rewrite URL and use global fetch
    const url = new URL(req.url);
    const newUrl = `${config.baseUrl}${url.pathname}${url.search}`;
    const newReq = new Request(newUrl, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      duplex: req.body ? "half" : undefined,
    } as RequestInit);
    return fetch(newReq);
  } else {
    // Local mode: use app.fetch with shared config.env (contains OAUTH_KV + OIDC config)
    const ctx = {
      props: { userId: "test-user", scopes: ["dovecote:notify"] },
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as ExecutionContext;
    return app.fetch(req, config.env, ctx);
  }
}

async function mcpRequest(
  method: string,
  params: Record<string, unknown>,
  id: number,
  token?: string,
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  let t = token;
  if (!t && !config.isRemote) {
    t = await getTestAccessToken();
  } else if (!t && config.isRemote) {
    t = config.authToken || undefined;
  }

  if (t) {
    headers.Authorization = `Bearer ${t}`;
  }

  return new Request("http://localhost/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
  });
}

function parseSSEData(text: string): any {
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  if (!dataLine) throw new Error(`No SSE data line in: ${text}`);
  return JSON.parse(dataLine.slice(6));
}

describe("E2E: Health", () => {
  it("GET /health returns ok", async () => {
    const res = await doFetch(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeDefined();
  });
});

describe("E2E: Auth", () => {
  it("rejects request without auth (OAuth required)", async () => {
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
        id: 1,
      }),
    });
    const res = await doFetch(req);
    expect(res.status).toBe(401);
  });

  it("rejects request with wrong token", async () => {
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer wrong-token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {},
        id: 1,
      }),
    });
    const res = await doFetch(req);
    expect(res.status).toBe(401);
  });
});

describe("E2E: MCP Initialize", () => {
  it("returns server info", async () => {
    const req = await mcpRequest(
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "e2e-test", version: "1.0.0" },
      },
      1,
    );
    const res = await doFetch(req);
    expect(res.status).toBe(200);

    const data = parseSSEData(await res.text());
    expect(data.result.serverInfo.name).toBe("dovecote-mcp-server");
    expect(data.result.serverInfo.version).toBe("1.0.0");
    expect(data.result.capabilities.tools).toBeDefined();
  });
});

describe("E2E: list_channels", () => {
  it("returns all channels with correct enabled status and service field", async () => {
    const req = await mcpRequest("tools/call", { name: "list_channels", arguments: {} }, 2);
    const res = await doFetch(req);
    expect(res.status).toBe(200);

    const data = parseSSEData(await res.text());
    const channels = JSON.parse(data.result.content[0].text);

    expect(channels).toHaveLength(config.expectedChannels.length);

    for (const channel of channels) {
      expect(channel.enabled).toBe(true);
      expect(channel.service).toBeDefined();
      expect(config.expectedChannels).toContain(channel.id);
    }
  });
});

describe("E2E: send_notification → Telegram", () => {
  it("sends message and verifies receipt via API response", async () => {
    const telegramChannel = config.expectedChannels.find((c) => c.startsWith("telegram-"));
    if (!telegramChannel) {
      console.log("Skipping: No Telegram instance configured");
      return;
    }

    const sentMessage = `E2E telegram test @ ${new Date().toISOString()}`;
    const req = await mcpRequest(
      "tools/call",
      {
        name: "send_notification",
        arguments: { channel: telegramChannel, content: { text: sentMessage } },
      },
      3,
    );
    const res = await doFetch(req);
    expect(res.status).toBe(200);

    const data = parseSSEData(await res.text());
    expect(data.result.isError).toBeUndefined();

    const result = JSON.parse(data.result.content[0].text);
    expect(result.channel).toBe(telegramChannel);
    expect(result.messageId).toBeDefined();
    expect(result.detail.text).toBe(sentMessage);
    expect(result.detail.chatId).toBeDefined();
  });
});

describe("E2E: send_notification → Discord", () => {
  it("sends message and verifies receipt via API response", async () => {
    const discordChannel = config.expectedChannels.find((c) => c.startsWith("discord-"));
    if (!discordChannel) {
      console.log("Skipping: No Discord instance configured");
      return;
    }

    const sentMessage = `E2E discord test @ ${new Date().toISOString()}`;
    const req = await mcpRequest(
      "tools/call",
      {
        name: "send_notification",
        arguments: { channel: discordChannel, content: { text: sentMessage } },
      },
      4,
    );
    const res = await doFetch(req);
    expect(res.status).toBe(200);

    const data = parseSSEData(await res.text());
    expect(data.result.isError).toBeUndefined();

    const result = JSON.parse(data.result.content[0].text);
    expect(result.channel).toBe(discordChannel);
    expect(result.messageId).toBeDefined();
    expect(result.detail.text).toBe(sentMessage);
    expect(result.detail.chatId).toBeDefined();
  });
});

describe("E2E: send_notification → unknown channel", () => {
  it("returns error for nonexistent channel", async () => {
    const req = await mcpRequest(
      "tools/call",
      {
        name: "send_notification",
        arguments: { channel: "slack", content: { text: "should fail" } },
      },
      5,
    );
    const res = await doFetch(req);
    expect(res.status).toBe(200);

    const data = parseSSEData(await res.text());
    const text: string = data.result.content[0].text;
    expect(text).toContain("Failed to send to slack");
    expect(data.result.isError).toBe(true);
  });
});

// ========================================
// Missing config scenarios
// ========================================

describe("E2E: no Telegram config", () => {
  const envNoTelegram: Env = {
    ...oauthDefaults,
    OAUTH_KV: config.env.OAUTH_KV, // Share KV to access OAuth tokens
    DISCORD_INSTANCES: JSON.stringify([{ id: "test", webhookUrl: "https://discord.com/api/webhooks/123/abc" }]),
  };

  it("list_channels shows only discord", async () => {
    if (config.isRemote) {
      console.log("Skipping: in-process test not applicable in remote mode");
      return;
    }

    const req = await mcpRequest("tools/call", { name: "list_channels", arguments: {} }, 10);
    const res = await app.fetch(req, envNoTelegram, authenticatedCtx);
    expect(res.status).toBe(200);

    const data = parseSSEData(await res.text());
    const channels = JSON.parse(data.result.content[0].text);
    expect(channels).toHaveLength(1);
    expect(channels[0].id).toBe("discord-test");
    expect(channels[0].service).toBe("discord");
  });

  it("send_notification to telegram returns unknown channel", async () => {
    if (config.isRemote) {
      console.log("Skipping: in-process test not applicable in remote mode");
      return;
    }

    const req = await mcpRequest(
      "tools/call",
      { name: "send_notification", arguments: { channel: "telegram-default", content: { text: "test" } } },
      11,
    );
    const res = await app.fetch(req, envNoTelegram, authenticatedCtx);
    expect(res.status).toBe(200);

    const data = parseSSEData(await res.text());
    expect(data.result.isError).toBe(true);
    expect(data.result.content[0].text).toContain("Unknown channel");
  });
});

describe("E2E: no Discord config", () => {
  const envNoDiscord: Env = {
    ...oauthDefaults,
    OAUTH_KV: config.env.OAUTH_KV, // Share KV to access OAuth tokens
    TELEGRAM_INSTANCES: JSON.stringify([{ id: "test", botToken: "fake:token", chatId: "123" }]),
  };

  it("list_channels shows only telegram", async () => {
    if (config.isRemote) {
      console.log("Skipping: in-process test not applicable in remote mode");
      return;
    }

    const req = await mcpRequest("tools/call", { name: "list_channels", arguments: {} }, 20);
    const res = await app.fetch(req, envNoDiscord, authenticatedCtx);
    expect(res.status).toBe(200);

    const data = parseSSEData(await res.text());
    const channels = JSON.parse(data.result.content[0].text);
    expect(channels).toHaveLength(1);
    expect(channels[0].id).toBe("telegram-test");
    expect(channels[0].service).toBe("telegram");
  });

  it("send_notification to discord returns unknown channel", async () => {
    if (config.isRemote) {
      console.log("Skipping: in-process test not applicable in remote mode");
      return;
    }

    const req = await mcpRequest(
      "tools/call",
      { name: "send_notification", arguments: { channel: "discord-default", content: { text: "test" } } },
      21,
    );
    const res = await app.fetch(req, envNoDiscord, authenticatedCtx);
    expect(res.status).toBe(200);

    const data = parseSSEData(await res.text());
    expect(data.result.isError).toBe(true);
    expect(data.result.content[0].text).toContain("Unknown channel");
  });
});

describe("E2E: no channel config at all", () => {
  const envEmpty: Env = {
    ...oauthDefaults,
    OAUTH_KV: config.env.OAUTH_KV, // Share KV to access OAuth tokens
  };

  it("list_channels returns empty array", async () => {
    if (config.isRemote) {
      console.log("Skipping: in-process test not applicable in remote mode");
      return;
    }

    const req = await mcpRequest("tools/call", { name: "list_channels", arguments: {} }, 30);
    const res = await app.fetch(req, envEmpty, {} as ExecutionContext);
    expect(res.status).toBe(200);

    const data = parseSSEData(await res.text());
    const channels = JSON.parse(data.result.content[0].text);
    expect(channels).toEqual([]);
  });

  it("send_notification to any channel returns unknown channel", async () => {
    if (config.isRemote) {
      console.log("Skipping: in-process test not applicable in remote mode");
      return;
    }

    for (const channel of ["telegram-default", "discord-default"]) {
      const req = await mcpRequest(
        "tools/call",
        { name: "send_notification", arguments: { channel, content: { text: "test" } } },
        31,
      );
      const res = await app.fetch(req, envEmpty, authenticatedCtx);
      expect(res.status).toBe(200);

      const data = parseSSEData(await res.text());
      expect(data.result.isError).toBe(true);
      expect(data.result.content[0].text).toContain("Unknown channel");
    }
  });
});

// ========================================
// E2E: Scope guard (C5, C6)
// ========================================

describe("E2E: scope guard", () => {
  const envWithChannels: Env = {
    ...oauthDefaults,
    OAUTH_KV: config.env.OAUTH_KV,
    DISCORD_INSTANCES: JSON.stringify([{ id: "test", webhookUrl: "https://discord.com/api/webhooks/123/abc" }]),
    TELEGRAM_INSTANCES: JSON.stringify([{ id: "test", botToken: "fake:token", chatId: "123" }]),
  };

  const noScopeCtx = {
    props: { userId: "e2e-no-scope", scopes: [] },
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as ExecutionContext;

  // C5: send_notification with no scope → forbidden
  it("C5: send_notification with no scope returns isError and Forbidden text", async () => {
    if (config.isRemote) {
      console.log("Skipping: in-process test not applicable in remote mode");
      return;
    }

    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "send_notification",
          arguments: { channel: "discord-test", content: { text: "should be forbidden" } },
        },
        id: 40,
      }),
    });

    const res = await apiApp.fetch(req, envWithChannels, noScopeCtx);
    expect(res.status).toBe(200);

    const data = parseSSEData(await res.text());
    expect(data.result.isError).toBe(true);
    expect(data.result.content[0].text).toMatch(/Forbidden/);
  });

  // C6: list_channels with no scope → forbidden, no channel names in response
  it("C6: list_channels with no scope returns isError and Forbidden, no channel names", async () => {
    if (config.isRemote) {
      console.log("Skipping: in-process test not applicable in remote mode");
      return;
    }

    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "list_channels",
          arguments: {},
        },
        id: 41,
      }),
    });

    const res = await apiApp.fetch(req, envWithChannels, noScopeCtx);
    expect(res.status).toBe(200);

    const data = parseSSEData(await res.text());
    expect(data.result.isError).toBe(true);
    const text: string = data.result.content[0].text;
    expect(text).toMatch(/Forbidden/);
    expect(text).not.toMatch(/discord-test|telegram-test/);
  });
});

// ========================================
