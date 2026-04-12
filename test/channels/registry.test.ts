import { describe, it, expect, mock, beforeEach } from "bun:test";
import {
  getChannelConfigs,
  sendToChannel,
} from "../../src/channels/registry";
import type { Env } from "../../src/types";

describe("getChannelConfigs", () => {
  it("returns all channels with correct enabled status", () => {
    const env: Env = {
      MCP_AUTH_TOKEN: "x",
      TELEGRAM_BOT_TOKEN: "b",
      TELEGRAM_CHAT_ID: "c",
    };
    const configs = getChannelConfigs(env);
    expect(configs).toHaveLength(2);
    expect(configs.find((c) => c.id === "telegram")?.enabled).toBe(true);
    expect(configs.find((c) => c.id === "discord")?.enabled).toBe(false);
  });

  it("returns all channels as disabled when no env vars set", () => {
    const env: Env = { MCP_AUTH_TOKEN: "x" };
    const configs = getChannelConfigs(env);
    expect(configs).toHaveLength(2);
    expect(configs.every((c) => !c.enabled)).toBe(true);
  });
});

describe("sendToChannel (BC5)", () => {
  beforeEach(() => {
    mock.restore();
  });

  it("returns error for unknown channel", async () => {
    const env: Env = { MCP_AUTH_TOKEN: "x" };
    const result = await sendToChannel("slack", { text: "Hello" }, env);
    expect(result).toEqual({
      success: false,
      channel: "slack",
      error: "Unknown channel",
    });
  });

  it("returns error for unconfigured channel", async () => {
    const env: Env = { MCP_AUTH_TOKEN: "x" };
    const result = await sendToChannel("telegram", { text: "msg" }, env);
    expect(result).toEqual({
      success: false,
      channel: "telegram",
      error: "Channel not configured",
    });
  });

  it("routes to Discord provider with embed", async () => {
    const mockFetch = mock(() => {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "discord-123",
            embeds: [{ title: "Test" }],
            channel_id: "ch-123",
          }),
          { status: 200 }
        )
      );
    });
    globalThis.fetch = mockFetch as any;

    const env: Env = {
      MCP_AUTH_TOKEN: "x",
      DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/abc",
    };
    const result = await sendToChannel(
      "discord",
      { embed: { title: "Test" } },
      env
    );
    expect(result.success).toBe(true);
    expect(result.channel).toBe("discord");
    expect(result.messageId).toBe("discord-123");
  });

  it("routes to Telegram provider with text", async () => {
    const mockFetch = mock(() => {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            result: { message_id: 123, text: "Hello", chat: { id: "chat456" } },
          }),
          { status: 200 }
        )
      );
    });
    globalThis.fetch = mockFetch as any;

    const env: Env = {
      MCP_AUTH_TOKEN: "x",
      TELEGRAM_BOT_TOKEN: "bot123",
      TELEGRAM_CHAT_ID: "chat456",
    };
    const result = await sendToChannel("telegram", { text: "Hello" }, env);
    expect(result.success).toBe(true);
    expect(result.channel).toBe("telegram");
    expect(result.messageId).toBe("123");
  });
});
