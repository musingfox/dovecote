import { describe, it, expect } from "bun:test";
import app from "../../src/index";
import type { Env } from "../../src/types";
import { config } from "./config";

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
    // Local mode: use app.fetch
    return app.fetch(req, config.env);
  }
}

function mcpRequest(
  method: string,
  params: Record<string, unknown>,
  id: number,
  token?: string
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  const t = token ?? config.authToken;
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
  it("rejects request without token", async () => {
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

  it("rejects request with wrong token", async () => {
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
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
    const req = mcpRequest(
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "e2e-test", version: "1.0.0" },
      },
      1
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
  it("returns all channels with correct enabled status", async () => {
    const req = mcpRequest("tools/call", { name: "list_channels", arguments: {} }, 2);
    const res = await doFetch(req);
    expect(res.status).toBe(200);

    const data = parseSSEData(await res.text());
    const channels = JSON.parse(data.result.content[0].text);

    expect(channels).toHaveLength(2);

    const telegram = channels.find((c: any) => c.id === "telegram");
    const discord = channels.find((c: any) => c.id === "discord");

    expect(telegram).toBeDefined();
    expect(discord).toBeDefined();

    if (config.env.TELEGRAM_BOT_TOKEN && config.env.TELEGRAM_CHAT_ID) {
      expect(telegram.enabled).toBe(true);
    }
    if (config.env.DISCORD_WEBHOOK_URL) {
      expect(discord.enabled).toBe(true);
    }
  });
});

describe("E2E: send_notification → Telegram", () => {
  it("sends message and verifies receipt via API response", async () => {
    if (!config.env.TELEGRAM_BOT_TOKEN || !config.env.TELEGRAM_CHAT_ID) {
      console.log("Skipping: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set");
      return;
    }

    const sentMessage = `E2E telegram test @ ${new Date().toISOString()}`;
    const req = mcpRequest(
      "tools/call",
      {
        name: "send_notification",
        arguments: { channel: "telegram", message: sentMessage },
      },
      3
    );
    const res = await doFetch(req);
    expect(res.status).toBe(200);

    const data = parseSSEData(await res.text());
    expect(data.result.isError).toBeUndefined();

    const result = JSON.parse(data.result.content[0].text);
    expect(result.channel).toBe("telegram");
    expect(result.messageId).toBeDefined();
    expect(result.detail.text).toBe(sentMessage);
    expect(result.detail.chatId).toBe(config.env.TELEGRAM_CHAT_ID);
  });
});

describe("E2E: send_notification → Discord", () => {
  it("sends message and verifies receipt via API response", async () => {
    if (!config.env.DISCORD_WEBHOOK_URL) {
      console.log("Skipping: DISCORD_WEBHOOK_URL not set");
      return;
    }

    const sentMessage = `E2E discord test @ ${new Date().toISOString()}`;
    const req = mcpRequest(
      "tools/call",
      {
        name: "send_notification",
        arguments: { channel: "discord", message: sentMessage },
      },
      4
    );
    const res = await doFetch(req);
    expect(res.status).toBe(200);

    const data = parseSSEData(await res.text());
    expect(data.result.isError).toBeUndefined();

    const result = JSON.parse(data.result.content[0].text);
    expect(result.channel).toBe("discord");
    expect(result.messageId).toBeDefined();
    expect(result.detail.text).toBe(sentMessage);
    expect(result.detail.chatId).toBeDefined();
  });
});

describe("E2E: send_notification → unknown channel", () => {
  it("returns error for nonexistent channel", async () => {
    const req = mcpRequest(
      "tools/call",
      {
        name: "send_notification",
        arguments: { channel: "slack", message: "should fail" },
      },
      5
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
    MCP_AUTH_TOKEN: "dev-test-token-123",
    DISCORD_WEBHOOK_URL: "https://example.com/webhook",
  };

  it("list_channels shows telegram disabled", async () => {
    if (config.isRemote) {
      console.log("Skipping: in-process test not applicable in remote mode");
      return;
    }

    const req = mcpRequest("tools/call", { name: "list_channels", arguments: {} }, 10);
    const res = await app.fetch(req, envNoTelegram);
    expect(res.status).toBe(200);

    const data = parseSSEData(await res.text());
    const channels = JSON.parse(data.result.content[0].text);
    const telegram = channels.find((c: any) => c.id === "telegram");
    expect(telegram.enabled).toBe(false);
  });

  it("send_notification to telegram returns channel not configured", async () => {
    if (config.isRemote) {
      console.log("Skipping: in-process test not applicable in remote mode");
      return;
    }

    const req = mcpRequest(
      "tools/call",
      { name: "send_notification", arguments: { channel: "telegram", message: "test" } },
      11
    );
    const res = await app.fetch(req, envNoTelegram);
    expect(res.status).toBe(200);

    const data = parseSSEData(await res.text());
    expect(data.result.isError).toBe(true);
    expect(data.result.content[0].text).toContain("Channel not configured");
  });
});

describe("E2E: no Discord config", () => {
  const envNoDiscord: Env = {
    MCP_AUTH_TOKEN: "dev-test-token-123",
    TELEGRAM_BOT_TOKEN: "fake:token",
    TELEGRAM_CHAT_ID: "123",
  };

  it("list_channels shows discord disabled", async () => {
    if (config.isRemote) {
      console.log("Skipping: in-process test not applicable in remote mode");
      return;
    }

    const req = mcpRequest("tools/call", { name: "list_channels", arguments: {} }, 20);
    const res = await app.fetch(req, envNoDiscord);
    expect(res.status).toBe(200);

    const data = parseSSEData(await res.text());
    const channels = JSON.parse(data.result.content[0].text);
    const discord = channels.find((c: any) => c.id === "discord");
    expect(discord.enabled).toBe(false);
  });

  it("send_notification to discord returns channel not configured", async () => {
    if (config.isRemote) {
      console.log("Skipping: in-process test not applicable in remote mode");
      return;
    }

    const req = mcpRequest(
      "tools/call",
      { name: "send_notification", arguments: { channel: "discord", message: "test" } },
      21
    );
    const res = await app.fetch(req, envNoDiscord);
    expect(res.status).toBe(200);

    const data = parseSSEData(await res.text());
    expect(data.result.isError).toBe(true);
    expect(data.result.content[0].text).toContain("Channel not configured");
  });
});

describe("E2E: no channel config at all", () => {
  const envEmpty: Env = {
    MCP_AUTH_TOKEN: "dev-test-token-123",
  };

  it("list_channels shows all disabled", async () => {
    if (config.isRemote) {
      console.log("Skipping: in-process test not applicable in remote mode");
      return;
    }

    const req = mcpRequest("tools/call", { name: "list_channels", arguments: {} }, 30);
    const res = await app.fetch(req, envEmpty);
    expect(res.status).toBe(200);

    const data = parseSSEData(await res.text());
    const channels = JSON.parse(data.result.content[0].text);
    expect(channels.every((c: any) => c.enabled === false)).toBe(true);
  });

  it("send_notification to any channel returns not configured", async () => {
    if (config.isRemote) {
      console.log("Skipping: in-process test not applicable in remote mode");
      return;
    }

    for (const channel of ["telegram", "discord"]) {
      const req = mcpRequest(
        "tools/call",
        { name: "send_notification", arguments: { channel, message: "test" } },
        31
      );
      const res = await app.fetch(req, envEmpty);
      expect(res.status).toBe(200);

      const data = parseSSEData(await res.text());
      expect(data.result.isError).toBe(true);
      expect(data.result.content[0].text).toContain("Channel not configured");
    }
  });
});
