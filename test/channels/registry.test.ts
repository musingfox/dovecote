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

describe("sendToChannel", () => {
  beforeEach(() => {
    mock.restore();
  });

  it("returns error for unknown channel", async () => {
    const env: Env = { MCP_AUTH_TOKEN: "x" };
    const result = await sendToChannel("slack", "msg", env);
    expect(result).toEqual({
      success: false,
      channel: "slack",
      error: "Unknown channel",
    });
  });

  it("returns error for unconfigured channel", async () => {
    const env: Env = { MCP_AUTH_TOKEN: "x" };
    const result = await sendToChannel("telegram", "msg", env);
    expect(result).toEqual({
      success: false,
      channel: "telegram",
      error: "Channel not configured",
    });
  });

  it("calls provider send when channel is configured", async () => {
    const mockFetch = mock(() => {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            result: { message_id: 123, text: "test message", chat: { id: "chat456" } },
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
    const result = await sendToChannel("telegram", "test message", env);
    expect(result.success).toBe(true);
    expect(result.channel).toBe("telegram");
    expect(result.messageId).toBe("123");
  });
});
