import { describe, it, expect, mock, beforeEach, spyOn } from "bun:test";
import {
  buildChannelRegistry,
  getChannelConfigs,
  sendToChannel,
} from "../../src/channels/registry";
import type { Env } from "../../src/types";

describe("buildChannelRegistry (BC3)", () => {
  it("env with telegram + discord instances → 2 registrations", () => {
    const env = {
      TELEGRAM_INSTANCES: JSON.stringify([
        { id: "alerts", botToken: "bot123", chatId: "chat456" },
      ]),
      DISCORD_INSTANCES: JSON.stringify([
        { id: "team-a", webhookUrl: "https://discord.com/api/webhooks/123/abc" },
      ]),
    } as Env;
    const registry = buildChannelRegistry(env);
    expect(registry).toHaveLength(2);
    expect(registry.find((r) => r.channelId === "telegram-alerts")).toBeDefined();
    expect(registry.find((r) => r.channelId === "discord-team-a")).toBeDefined();
  });

  it("empty env → []", () => {
    const env = {} as Env;
    const registry = buildChannelRegistry(env);
    expect(registry).toEqual([]);
  });

  it("malformed JSON in one service → that service yields 0, other still works; console.warn called", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const env = {
      TELEGRAM_INSTANCES: "not json",
      DISCORD_INSTANCES: JSON.stringify([
        { id: "team-a", webhookUrl: "https://discord.com/api/webhooks/123/abc" },
      ]),
    } as Env;
    const registry = buildChannelRegistry(env);
    expect(registry).toHaveLength(1);
    expect(registry[0]?.channelId).toBe("discord-team-a");
    expect(warnSpy).toHaveBeenCalledWith("TELEGRAM_INSTANCES: invalid JSON");

    warnSpy.mockRestore();
  });
});

describe("getChannelConfigs (BC4)", () => {
  it("includes service field, name like 'Telegram (alerts)', enabled: true", () => {
    const env = {
      TELEGRAM_INSTANCES: JSON.stringify([
        { id: "alerts", botToken: "bot123", chatId: "chat456" },
      ]),
      DISCORD_INSTANCES: JSON.stringify([
        { id: "team-a", webhookUrl: "https://discord.com/api/webhooks/123/abc" },
      ]),
    } as Env;
    const configs = getChannelConfigs(env);
    expect(configs).toHaveLength(2);

    const telegramConfig = configs.find((c) => c.id === "telegram-alerts");
    expect(telegramConfig).toEqual({
      id: "telegram-alerts",
      name: "Telegram (alerts)",
      enabled: true,
      service: "telegram",
    });

    const discordConfig = configs.find((c) => c.id === "discord-team-a");
    expect(discordConfig).toEqual({
      id: "discord-team-a",
      name: "Discord (team-a)",
      enabled: true,
      service: "discord",
    });
  });

  it("empty env → []", () => {
    const env = {} as Env;
    const configs = getChannelConfigs(env);
    expect(configs).toEqual([]);
  });
});

describe("sendToChannel (BC5)", () => {
  beforeEach(() => {
    mock.restore();
  });

  it("sendToChannel('telegram-alerts', content, env) → success, channel = 'telegram-alerts'", async () => {
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

    const env = {
      TELEGRAM_INSTANCES: JSON.stringify([
        { id: "alerts", botToken: "bot123", chatId: "chat456" },
      ]),
    } as Env;
    const result = await sendToChannel("telegram-alerts", { text: "Hello" }, env);
    expect(result.success).toBe(true);
    expect(result.channel).toBe("telegram-alerts");
    expect(result.messageId).toBe("123");
  });

  it("sendToChannel('slack-general', ...) → { success: false, error: 'Unknown channel' }", async () => {
    const env = {} as Env;
    const result = await sendToChannel("slack-general", { text: "Hello" }, env);
    expect(result).toEqual({
      success: false,
      channel: "slack-general",
      error: "Unknown channel",
    });
  });

  it("sendToChannel('telegram', ...) → { success: false, error: 'Unknown channel' }", async () => {
    const env = {
      TELEGRAM_INSTANCES: JSON.stringify([
        { id: "alerts", botToken: "bot123", chatId: "chat456" },
      ]),
    } as Env;
    const result = await sendToChannel("telegram", { text: "msg" }, env);
    expect(result).toEqual({
      success: false,
      channel: "telegram",
      error: "Unknown channel",
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

    const env = {
      DISCORD_INSTANCES: JSON.stringify([
        { id: "team-a", webhookUrl: "https://discord.com/api/webhooks/123/abc" },
      ]),
    } as Env;
    const result = await sendToChannel(
      "discord-team-a",
      { embed: { title: "Test" } },
      env
    );
    expect(result.success).toBe(true);
    expect(result.channel).toBe("discord-team-a");
    expect(result.messageId).toBe("discord-123");
  });
});
