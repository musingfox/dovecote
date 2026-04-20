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
  it("allows request without token (authless mode)", async () => {
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
    expect(res.status).toBe(200);
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
  it("returns all channels with correct enabled status and service field", async () => {
    const req = mcpRequest("tools/call", { name: "list_channels", arguments: {} }, 2);
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
    const telegramChannel = config.expectedChannels.find(c => c.startsWith("telegram-"));
    if (!telegramChannel) {
      console.log("Skipping: No Telegram instance configured");
      return;
    }

    const sentMessage = `E2E telegram test @ ${new Date().toISOString()}`;
    const req = mcpRequest(
      "tools/call",
      {
        name: "send_notification",
        arguments: { channel: telegramChannel, content: { text: sentMessage } },
      },
      3
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
    const discordChannel = config.expectedChannels.find(c => c.startsWith("discord-"));
    if (!discordChannel) {
      console.log("Skipping: No Discord instance configured");
      return;
    }

    const sentMessage = `E2E discord test @ ${new Date().toISOString()}`;
    const req = mcpRequest(
      "tools/call",
      {
        name: "send_notification",
        arguments: { channel: discordChannel, content: { text: sentMessage } },
      },
      4
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
    const req = mcpRequest(
      "tools/call",
      {
        name: "send_notification",
        arguments: { channel: "slack", content: { text: "should fail" } },
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
    DISCORD_INSTANCES: JSON.stringify([{ id: "test", webhookUrl: "https://discord.com/api/webhooks/123/abc" }]),
  };

  it("list_channels shows only discord", async () => {
    if (config.isRemote) {
      console.log("Skipping: in-process test not applicable in remote mode");
      return;
    }

    const req = mcpRequest("tools/call", { name: "list_channels", arguments: {} }, 10);
    const res = await app.fetch(req, envNoTelegram);
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

    const req = mcpRequest(
      "tools/call",
      { name: "send_notification", arguments: { channel: "telegram-default", content: { text: "test" } } },
      11
    );
    const res = await app.fetch(req, envNoTelegram);
    expect(res.status).toBe(200);

    const data = parseSSEData(await res.text());
    expect(data.result.isError).toBe(true);
    expect(data.result.content[0].text).toContain("Unknown channel");
  });
});

describe("E2E: no Discord config", () => {
  const envNoDiscord: Env = {
    MCP_AUTH_TOKEN: "dev-test-token-123",
    TELEGRAM_INSTANCES: JSON.stringify([{ id: "test", botToken: "fake:token", chatId: "123" }]),
  };

  it("list_channels shows only telegram", async () => {
    if (config.isRemote) {
      console.log("Skipping: in-process test not applicable in remote mode");
      return;
    }

    const req = mcpRequest("tools/call", { name: "list_channels", arguments: {} }, 20);
    const res = await app.fetch(req, envNoDiscord);
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

    const req = mcpRequest(
      "tools/call",
      { name: "send_notification", arguments: { channel: "discord-default", content: { text: "test" } } },
      21
    );
    const res = await app.fetch(req, envNoDiscord);
    expect(res.status).toBe(200);

    const data = parseSSEData(await res.text());
    expect(data.result.isError).toBe(true);
    expect(data.result.content[0].text).toContain("Unknown channel");
  });
});

describe("E2E: no channel config at all", () => {
  const envEmpty: Env = {
    MCP_AUTH_TOKEN: "dev-test-token-123",
  };

  it("list_channels returns empty array", async () => {
    if (config.isRemote) {
      console.log("Skipping: in-process test not applicable in remote mode");
      return;
    }

    const req = mcpRequest("tools/call", { name: "list_channels", arguments: {} }, 30);
    const res = await app.fetch(req, envEmpty);
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
      const req = mcpRequest(
        "tools/call",
        { name: "send_notification", arguments: { channel, content: { text: "test" } } },
        31
      );
      const res = await app.fetch(req, envEmpty);
      expect(res.status).toBe(200);

      const data = parseSSEData(await res.text());
      expect(data.result.isError).toBe(true);
      expect(data.result.content[0].text).toContain("Unknown channel");
    }
  });
});
