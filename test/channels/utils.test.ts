import { describe, it, expect } from "bun:test";
import {
  splitChannelId,
  isValidDiscordWebhookUrl,
  channelKey,
  serializeChannelRecord,
  CHANNEL_KEY_PREFIX,
} from "../../src/channels/utils";

describe("splitChannelId (BC3a)", () => {
  it("telegram-alerts → { service: 'telegram', instance: 'alerts' }", () => {
    expect(splitChannelId("telegram-alerts")).toEqual({
      service: "telegram",
      instance: "alerts",
    });
  });

  it("telegram-team-a → { service: 'telegram', instance: 'team-a' }", () => {
    expect(splitChannelId("telegram-team-a")).toEqual({
      service: "telegram",
      instance: "team-a",
    });
  });

  it("telegram-my-bot → { service: 'telegram', instance: 'my-bot' }", () => {
    expect(splitChannelId("telegram-my-bot")).toEqual({
      service: "telegram",
      instance: "my-bot",
    });
  });

  it("discord-team-a → { service: 'discord', instance: 'team-a' }", () => {
    expect(splitChannelId("discord-team-a")).toEqual({
      service: "discord",
      instance: "team-a",
    });
  });

  it("telegram → null (no dash)", () => {
    expect(splitChannelId("telegram")).toBeNull();
  });

  it("-alerts → null (empty service)", () => {
    expect(splitChannelId("-alerts")).toBeNull();
  });

  it("telegram- → null (empty instance)", () => {
    expect(splitChannelId("telegram-")).toBeNull();
  });

  it("empty string → null", () => {
    expect(splitChannelId("")).toBeNull();
  });
});

describe("isValidDiscordWebhookUrl (BC-SSRF1)", () => {
  it("accepts https://discord.com/api/webhooks/123456789012345678/abcDEF_token-value", () => {
    expect(isValidDiscordWebhookUrl("https://discord.com/api/webhooks/123456789012345678/abcDEF_token-value")).toBe(true);
  });

  it("accepts https://discordapp.com/api/webhooks/123/tok", () => {
    expect(isValidDiscordWebhookUrl("https://discordapp.com/api/webhooks/123/tok")).toBe(true);
  });

  it("accepts https://DISCORD.COM/api/webhooks/1/t (case-insensitive hostname)", () => {
    expect(isValidDiscordWebhookUrl("https://DISCORD.COM/api/webhooks/1/t")).toBe(true);
  });

  it("accepts https://discord.com:443/api/webhooks/1/t (explicit default port normalizes)", () => {
    expect(isValidDiscordWebhookUrl("https://discord.com:443/api/webhooks/1/t")).toBe(true);
  });

  it("rejects http://discord.com/api/webhooks/1/t (http)", () => {
    expect(isValidDiscordWebhookUrl("http://discord.com/api/webhooks/1/t")).toBe(false);
  });

  it("rejects https://evil.com/api/webhooks/1/t (wrong host)", () => {
    expect(isValidDiscordWebhookUrl("https://evil.com/api/webhooks/1/t")).toBe(false);
  });

  it("rejects https://discord.com.evil.com/api/webhooks/1/t (suffix confusion)", () => {
    expect(isValidDiscordWebhookUrl("https://discord.com.evil.com/api/webhooks/1/t")).toBe(false);
  });

  it("rejects https://discord.com/api/users/@me (wrong path)", () => {
    expect(isValidDiscordWebhookUrl("https://discord.com/api/users/@me")).toBe(false);
  });

  it("rejects https://169.254.169.254/api/webhooks/1/t (metadata IP)", () => {
    expect(isValidDiscordWebhookUrl("https://169.254.169.254/api/webhooks/1/t")).toBe(false);
  });

  it("rejects https://localhost/api/webhooks/1/t (localhost)", () => {
    expect(isValidDiscordWebhookUrl("https://localhost/api/webhooks/1/t")).toBe(false);
  });

  it("rejects 'not-a-url' (malformed)", () => {
    expect(isValidDiscordWebhookUrl("not-a-url")).toBe(false);
  });

  it("rejects '' (empty)", () => {
    expect(isValidDiscordWebhookUrl("")).toBe(false);
  });

  it("rejects https://discord.com:81/api/webhooks/1/t (non-default port)", () => {
    expect(isValidDiscordWebhookUrl("https://discord.com:81/api/webhooks/1/t")).toBe(false);
  });
});

describe("channelKey / CHANNEL_KEY_PREFIX (ChannelKeyAndRecordFormat)", () => {
  it("channelKey('telegram', 'default') → 'channel:telegram-default'", () => {
    expect(channelKey("telegram", "default")).toBe("channel:telegram-default");
  });

  it("channelKey('discord', 'team-frontend') → 'channel:discord-team-frontend'", () => {
    expect(channelKey("discord", "team-frontend")).toBe("channel:discord-team-frontend");
  });

  it("CHANNEL_KEY_PREFIX === 'channel:'", () => {
    expect(CHANNEL_KEY_PREFIX).toBe("channel:");
  });

  it("channelKey is the prefix followed by the composite channel id", () => {
    const key = channelKey("telegram", "ops");
    expect(key.startsWith(CHANNEL_KEY_PREFIX)).toBe(true);
    expect(key.slice(CHANNEL_KEY_PREFIX.length)).toBe("telegram-ops");
  });
});

describe("serializeChannelRecord (ChannelKeyAndRecordFormat)", () => {
  it("telegram record: fixed key order, service and id first", () => {
    expect(serializeChannelRecord("telegram", { id: "ops", botToken: "t", chatId: "c" })).toBe(
      '{"service":"telegram","id":"ops","botToken":"t","chatId":"c"}'
    );
  });

  it("discord record: fixed key order, service and id first", () => {
    expect(
      serializeChannelRecord("discord", {
        id: "ops",
        webhookUrl: "https://discord.com/api/webhooks/1/t",
      })
    ).toBe('{"service":"discord","id":"ops","webhookUrl":"https://discord.com/api/webhooks/1/t"}');
  });

  it("serializing the same config twice yields identical strings (idempotency precondition)", () => {
    const config = { id: "ops", botToken: "t", chatId: "c" };
    expect(serializeChannelRecord("telegram", config)).toBe(
      serializeChannelRecord("telegram", config)
    );
  });

  it("caller key order does not leak into the serialized record", () => {
    const reordered = { chatId: "c", botToken: "t", id: "ops" };
    expect(serializeChannelRecord("telegram", reordered)).toBe(
      '{"service":"telegram","id":"ops","botToken":"t","chatId":"c"}'
    );
  });
});
