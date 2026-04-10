import { describe, it, expect, beforeAll } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import app from "../../src/index";
import type { Env } from "../../src/types";

/**
 * E2E tests — hit real Telegram/Discord APIs via app.fetch().
 *
 * Requires .dev.vars with valid credentials.
 * Run explicitly: bun test test/e2e/
 */

let env: Env;

function parseDevVars(path: string): Record<string, string> {
  const content = readFileSync(path, "utf-8");
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx > 0) {
      vars[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
    }
  }
  return vars;
}

beforeAll(() => {
  const varsPath = resolve(import.meta.dir, "../../.dev.vars");
  const vars = parseDevVars(varsPath);

  if (!vars.MCP_AUTH_TOKEN) {
    throw new Error("Missing MCP_AUTH_TOKEN in .dev.vars");
  }

  env = {
    MCP_AUTH_TOKEN: vars.MCP_AUTH_TOKEN,
    TELEGRAM_BOT_TOKEN: vars.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: vars.TELEGRAM_CHAT_ID,
    DISCORD_WEBHOOK_URL: vars.DISCORD_WEBHOOK_URL,
  };
});

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
  const t = token ?? env.MCP_AUTH_TOKEN;
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
    const res = await app.fetch(new Request("http://localhost/health"), env);
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
    const res = await app.fetch(req, env);
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
    const res = await app.fetch(req, env);
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
    const res = await app.fetch(req, env);
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
    const res = await app.fetch(req, env);
    expect(res.status).toBe(200);

    const data = parseSSEData(await res.text());
    const channels = JSON.parse(data.result.content[0].text);

    expect(channels).toHaveLength(2);

    const telegram = channels.find((c: any) => c.id === "telegram");
    const discord = channels.find((c: any) => c.id === "discord");

    expect(telegram).toBeDefined();
    expect(discord).toBeDefined();

    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      expect(telegram.enabled).toBe(true);
    }
    if (env.DISCORD_WEBHOOK_URL) {
      expect(discord.enabled).toBe(true);
    }
  });
});

describe("E2E: send_notification → Telegram", () => {
  it("sends message and verifies receipt via API response", async () => {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
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
    const res = await app.fetch(req, env);
    expect(res.status).toBe(200);

    const data = parseSSEData(await res.text());
    expect(data.result.isError).toBeUndefined();

    const result = JSON.parse(data.result.content[0].text);
    expect(result.channel).toBe("telegram");
    expect(result.messageId).toBeDefined();
    expect(result.detail.text).toBe(sentMessage);
    expect(result.detail.chatId).toBe(env.TELEGRAM_CHAT_ID);
  });
});

describe("E2E: send_notification → Discord", () => {
  it("sends message and verifies receipt via API response", async () => {
    if (!env.DISCORD_WEBHOOK_URL) {
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
    const res = await app.fetch(req, env);
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
    const res = await app.fetch(req, env);
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
    const req = mcpRequest("tools/call", { name: "list_channels", arguments: {} }, 10);
    const res = await app.fetch(req, envNoTelegram);
    expect(res.status).toBe(200);

    const data = parseSSEData(await res.text());
    const channels = JSON.parse(data.result.content[0].text);
    const telegram = channels.find((c: any) => c.id === "telegram");
    expect(telegram.enabled).toBe(false);
  });

  it("send_notification to telegram returns channel not configured", async () => {
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
    const req = mcpRequest("tools/call", { name: "list_channels", arguments: {} }, 20);
    const res = await app.fetch(req, envNoDiscord);
    expect(res.status).toBe(200);

    const data = parseSSEData(await res.text());
    const channels = JSON.parse(data.result.content[0].text);
    const discord = channels.find((c: any) => c.id === "discord");
    expect(discord.enabled).toBe(false);
  });

  it("send_notification to discord returns channel not configured", async () => {
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
    const req = mcpRequest("tools/call", { name: "list_channels", arguments: {} }, 30);
    const res = await app.fetch(req, envEmpty);
    expect(res.status).toBe(200);

    const data = parseSSEData(await res.text());
    const channels = JSON.parse(data.result.content[0].text);
    expect(channels.every((c: any) => c.enabled === false)).toBe(true);
  });

  it("send_notification to any channel returns not configured", async () => {
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
