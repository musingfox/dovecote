import { describe, it, expect } from "bun:test";
import app from "../../src/index";
import apiApp from "../../src/api";
import type { Env } from "../../src/types";
import type { ExecutionContext } from "@cloudflare/workers-types";
import { config } from "./config";
import { runFormOAuthFlow } from "../helpers/form-oauth";

const SUBJECT = "notif-test-user";

const oauthDefaults = {
  OAUTH_KV: config.env.OAUTH_KV,
  HMAC_PEPPER: "test-pepper",
  ADMIN_REVOKE_TOKEN: "admin-test-token",
  ENABLE_CLIENT_BOOTSTRAP: "1",
};

const DISCORD_TEST_RECORD = JSON.stringify({
  service: "discord",
  id: "test",
  webhookUrl: "https://discord.com/api/webhooks/123/abc",
});
const TELEGRAM_TEST_RECORD = JSON.stringify({
  service: "telegram",
  id: "test",
  botToken: "fake:token",
  chatId: "123",
});

/**
 * An Env whose channel set is exactly `records`. Channels live in KV now, but
 * the OAuth grants/tokens minted for these in-process tests live in the shared
 * `config.env.OAUTH_KV`, so this layers the `channel:` keyspace on top of the
 * shared namespace instead of replacing it — each scenario sees only its own
 * channels while still authenticating against the shared token store.
 */
function envWithChannels(records: Record<string, string>): Env {
  const shared = config.env.OAUTH_KV as any;
  const kv = {
    get: async (key: string, options?: unknown) => {
      if (!key.startsWith("channel:")) return shared.get(key, options);
      return records[key] ?? null;
    },
    put: async (key: string, value: string, options?: unknown) => {
      if (!key.startsWith("channel:")) return shared.put(key, value, options);
      records[key] = value;
    },
    delete: async (key: string) => {
      if (!key.startsWith("channel:")) return shared.delete(key);
      delete records[key];
    },
    list: async (options?: { prefix?: string; limit?: number }) => {
      if (options?.prefix?.startsWith("channel:")) {
        const keys = Object.keys(records)
          .filter((name) => name.startsWith(options.prefix!))
          .map((name) => ({ name }));
        return { keys, list_complete: true };
      }
      return shared.list(options);
    },
    getWithMetadata: async (key: string) => {
      if (!key.startsWith("channel:")) return shared.getWithMetadata(key);
      const value = records[key] ?? null;
      return { value, metadata: null };
    },
  };
  return { ...oauthDefaults, OAUTH_KV: kv as any };
}

const authenticatedCtx = {
  props: { userId: "test-user", scopes: ["dovecote:notify"] },
  waitUntil: () => {},
  passThroughOnException: () => {},
} as ExecutionContext;

// ── token-paste form flow helper (M1 — OIDC RP retired) ───────────────────────

/**
 * Run the full token-paste OAuth flow against the in-process app to obtain an
 * access token. Uses config.env (shared KV) so grants/tokens persist across
 * doFetch calls.
 */
async function runFormFlow(clientId: string, scope: string, stateVal: string): Promise<string> {
  const { accessToken } = await runFormOAuthFlow({
    doFetch,
    env: config.env,
    clientId,
    redirectUri: "https://test.local/callback",
    scope,
    state: stateVal,
    userId: SUBJECT,
    tokenScopes: scope.split(" ").filter(Boolean),
  });
  return accessToken;
}

// Helper to get an OAuth access token for local testing via the form flow
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

  cachedAccessToken = await runFormFlow(clientId, "dovecote:notify", "test-state");
  return cachedAccessToken;
}

// Cache for narrow-scope tokens, keyed by scope string
const narrowScopeTokenCache = new Map<string, string>();

/**
 * Get an OAuth access token for a specific scope (not the default full-scope token).
 * Uses a separate client registration per scope to avoid token conflicts.
 */
export async function getTestAccessTokenForScope(scope: string): Promise<string> {
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

  const token = await runFormFlow(clientId, scope, "test-state-narrow");
  narrowScopeTokenCache.set(scope, token);
  return token;
}

/**
 * E2E tests — supports both local (in-process) and remote (HTTP) testing.
 *
 * Local mode (default): Requires .dev.vars with valid credentials.
 * Remote mode: Set TEST_BASE_URL and TEST_AUTH_TOKEN environment variables.
 *
 * Run explicitly: bun test --path-ignore-patterns "" test/e2e/
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
    // Local mode: use app.fetch with shared config.env (contains OAUTH_KV)
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
  const envNoTelegram: Env = envWithChannels({
    "channel:discord-test": DISCORD_TEST_RECORD,
  });

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
  const envNoDiscord: Env = envWithChannels({
    "channel:telegram-test": TELEGRAM_TEST_RECORD,
  });

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
  const envEmpty: Env = envWithChannels({});

  it("list_channels returns empty array", async () => {
    if (config.isRemote) {
      console.log("Skipping: in-process test not applicable in remote mode");
      return;
    }

    const req = await mcpRequest("tools/call", { name: "list_channels", arguments: {} }, 30);
    const res = await app.fetch(req, envEmpty, authenticatedCtx);
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
  const envBothChannels: Env = envWithChannels({
    "channel:discord-test": DISCORD_TEST_RECORD,
    "channel:telegram-test": TELEGRAM_TEST_RECORD,
  });

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

    const res = await apiApp.fetch(req, envBothChannels, noScopeCtx);
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

    const res = await apiApp.fetch(req, envBothChannels, noScopeCtx);
    expect(res.status).toBe(200);

    const data = parseSSEData(await res.text());
    expect(data.result.isError).toBe(true);
    const text: string = data.result.content[0].text;
    expect(text).toMatch(/Forbidden/);
    expect(text).not.toMatch(/discord-test|telegram-test/);
  });
});
