import { describe, it, expect, mock, beforeEach } from "bun:test";
import { TelegramProvider, telegramFactory } from "../../src/channels/telegram";

describe("TelegramProvider (BC4)", () => {
  beforeEach(() => {
    // Reset fetch mock before each test
    mock.restore();
  });

  it("send text only → sends { chat_id, text }", async () => {
    const mockFetch = mock((url: string, options?: any) => {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            result: { message_id: 456, text: "Hello", chat: { id: "chat456" } },
          }),
          { status: 200 }
        )
      );
    });
    globalThis.fetch = mockFetch as any;

    const provider = new TelegramProvider("123:ABC", "chat456");
    const result = await provider.send({ text: "Hello" });

    expect(result).toEqual({
      success: true,
      channel: "telegram",
      messageId: "456",
      detail: { text: "Hello", chatId: "chat456" },
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      "https://api.telegram.org/bot123:ABC/sendMessage"
    );
    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body ?? "{}");
    expect(body).toEqual({ chat_id: "chat456", text: "Hello" });
  });

  it("send with embed ignored → sends only text, embed not in payload", async () => {
    const mockFetch = mock((url: string, options?: any) => {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            result: { message_id: 457, text: "Notification", chat: { id: "chat456" } },
          }),
          { status: 200 }
        )
      );
    });
    globalThis.fetch = mockFetch as any;

    const provider = new TelegramProvider("123:ABC", "chat456");
    const result = await provider.send({
      text: "Notification",
      embed: { title: "Ignored" },
    });

    expect(result.success).toBe(true);
    expect(result.channel).toBe("telegram");
    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body ?? "{}");
    expect(body.text).toBe("Notification");
    expect(body).not.toHaveProperty("embed");
    expect(body).not.toHaveProperty("embeds");
  });

  it("send embed-only → returns error (Telegram requires text)", async () => {
    const provider = new TelegramProvider("123:ABC", "chat456");
    const result = await provider.send({
      embed: { title: "No text" },
    });

    expect(result.success).toBe(false);
    expect(result.channel).toBe("telegram");
    expect(result.error).toBe("Telegram requires text content");
  });

  it("send returns failure on non-ok response", async () => {
    const mockFetch = mock(() => {
      return Promise.resolve(new Response("Unauthorized", { status: 401 }));
    });
    globalThis.fetch = mockFetch as any;

    const provider = new TelegramProvider("bad:token", "chat456");
    const result = await provider.send({ text: "Hello" });

    expect(result.success).toBe(false);
    expect(result.channel).toBe("telegram");
    expect(result.error).toBeDefined();
    expect(result.error).toContain("401");
  });

  it("send returns failure on network error", async () => {
    const mockFetch = mock(() => {
      throw new Error("Network error");
    });
    globalThis.fetch = mockFetch as any;

    const provider = new TelegramProvider("123:ABC", "chat456");
    const result = await provider.send({ text: "Hello" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Network error");
  });
});

describe("telegramFactory", () => {
  it("create returns provider when both env vars set", () => {
    const env = {
      MCP_AUTH_TOKEN: "x",
      TELEGRAM_BOT_TOKEN: "bot123",
      TELEGRAM_CHAT_ID: "chat456",
    };
    expect(telegramFactory.create(env)).not.toBeNull();
  });

  it("create returns null when env vars missing", () => {
    const env = { MCP_AUTH_TOKEN: "x" };
    expect(telegramFactory.create(env as any)).toBeNull();
  });

  it("getConfig returns enabled true when configured", () => {
    const env = {
      MCP_AUTH_TOKEN: "x",
      TELEGRAM_BOT_TOKEN: "bot123",
      TELEGRAM_CHAT_ID: "chat456",
    };
    expect(telegramFactory.getConfig(env)).toEqual({
      id: "telegram",
      name: "Telegram",
      enabled: true,
    });
  });

  it("getConfig returns enabled false when not configured", () => {
    const env = { MCP_AUTH_TOKEN: "x" };
    expect(telegramFactory.getConfig(env as any)).toEqual({
      id: "telegram",
      name: "Telegram",
      enabled: false,
    });
  });
});
