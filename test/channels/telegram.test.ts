import { describe, it, expect, mock, beforeEach } from "bun:test";
import { TelegramProvider, telegramAdapter } from "../../src/channels/telegram";

describe("TelegramProvider (BC6)", () => {
  beforeEach(() => {
    mock.restore();
  });

  it("constructor accepts channelId, botToken, chatId", () => {
    const provider = new TelegramProvider("telegram-alerts", "123:ABC", "chat456");
    expect(provider).toBeDefined();
  });

  it("send text only → success with composite channelId", async () => {
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

    const provider = new TelegramProvider("telegram-alerts", "123:ABC", "chat456");
    const result = await provider.send({ text: "Hello" });

    expect(result).toEqual({
      success: true,
      channel: "telegram-alerts",
      messageId: "456",
      detail: { text: "Hello", chatId: "chat456" },
    });
  });

  it("send embed-only → 'Telegram requires text content'", async () => {
    const provider = new TelegramProvider("telegram-alerts", "123:ABC", "chat456");
    const result = await provider.send({
      embed: { title: "No text" },
    });

    expect(result.success).toBe(false);
    expect(result.channel).toBe("telegram-alerts");
    expect(result.error).toBe("Telegram requires text content");
  });

  it("send returns HTTP 401 error", async () => {
    const mockFetch = mock(() => {
      return Promise.resolve(new Response("Unauthorized", { status: 401 }));
    });
    globalThis.fetch = mockFetch as any;

    const provider = new TelegramProvider("telegram-alerts", "bad:token", "chat456");
    const result = await provider.send({ text: "Hello" });

    expect(result.success).toBe(false);
    expect(result.channel).toBe("telegram-alerts");
    expect(result.error).toContain("HTTP 401");
  });

  it("JSON with description field → extract description (BC-SANITIZE-TELEGRAM)", async () => {
    const mockFetch = mock(() => {
      return Promise.resolve(
        new Response(
          JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }),
          { status: 401 }
        )
      );
    });
    globalThis.fetch = mockFetch as any;

    const provider = new TelegramProvider("telegram-alerts", "bad:token", "chat456");
    const result = await provider.send({ text: "Hello" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("HTTP 401: Unauthorized");
  });

  it("non-JSON short → use raw text (BC-SANITIZE-TELEGRAM)", async () => {
    const mockFetch = mock(() => {
      return Promise.resolve(new Response("Unauthorized", { status: 401 }));
    });
    globalThis.fetch = mockFetch as any;

    const provider = new TelegramProvider("telegram-alerts", "bad:token", "chat456");
    const result = await provider.send({ text: "Hello" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("HTTP 401: Unauthorized");
  });

  it("non-JSON long → truncate to 100 chars + '...' (BC-SANITIZE-TELEGRAM)", async () => {
    const mockFetch = mock(() => {
      return Promise.resolve(new Response("A".repeat(200), { status: 500 }));
    });
    globalThis.fetch = mockFetch as any;

    const provider = new TelegramProvider("telegram-alerts", "bad:token", "chat456");
    const result = await provider.send({ text: "Hello" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("HTTP 500: " + "A".repeat(100) + "...");
  });

  it("JSON without description → use raw JSON (BC-SANITIZE-TELEGRAM)", async () => {
    const mockFetch = mock(() => {
      return Promise.resolve(
        new Response(
          JSON.stringify({ ok: false, error_code: 400 }),
          { status: 400 }
        )
      );
    });
    globalThis.fetch = mockFetch as any;

    const provider = new TelegramProvider("telegram-alerts", "bad:token", "chat456");
    const result = await provider.send({ text: "Hello" });

    expect(result.success).toBe(false);
    expect(result.error).toBe('HTTP 400: {"ok":false,"error_code":400}');
  });

  it("JSON with non-string description → use raw JSON (BC-SANITIZE-TELEGRAM)", async () => {
    const mockFetch = mock(() => {
      return Promise.resolve(
        new Response(
          JSON.stringify({ description: 123 }),
          { status: 400 }
        )
      );
    });
    globalThis.fetch = mockFetch as any;

    const provider = new TelegramProvider("telegram-alerts", "bad:token", "chat456");
    const result = await provider.send({ text: "Hello" });

    expect(result.success).toBe(false);
    expect(result.error).toBe('HTTP 400: {"description":123}');
  });
});

describe("telegramAdapter (BC1, BC8)", () => {
  it("service === 'telegram'", () => {
    expect(telegramAdapter.service).toBe("telegram");
  });

  it("envKey === 'TELEGRAM_INSTANCES'", () => {
    expect(telegramAdapter.envKey).toBe("TELEGRAM_INSTANCES");
  });

  it("parseInstances: undefined → empty, no errors", () => {
    const result = telegramAdapter.parseInstances(undefined);
    expect(result).toEqual({ instances: [], errors: [] });
  });

  it("parseInstances: empty string → empty, no errors", () => {
    const result = telegramAdapter.parseInstances("");
    expect(result).toEqual({ instances: [], errors: [] });
  });

  it("parseInstances: valid single instance", () => {
    const json = JSON.stringify([
      { id: "alerts", botToken: "bot123", chatId: "chat456" },
    ]);
    const result = telegramAdapter.parseInstances(json);
    expect(result.instances).toEqual([
      { id: "alerts", botToken: "bot123", chatId: "chat456" },
    ]);
    expect(result.errors).toEqual([]);
  });

  it("parseInstances: id lowercased", () => {
    const json = JSON.stringify([
      { id: "Alerts", botToken: "bot123", chatId: "chat456" },
    ]);
    const result = telegramAdapter.parseInstances(json);
    expect(result.instances).toEqual([
      { id: "alerts", botToken: "bot123", chatId: "chat456" },
    ]);
  });

  it("parseInstances: dash allowed (my-bot)", () => {
    const json = JSON.stringify([
      { id: "my-bot", botToken: "bot123", chatId: "chat456" },
    ]);
    const result = telegramAdapter.parseInstances(json);
    expect(result.instances).toEqual([
      { id: "my-bot", botToken: "bot123", chatId: "chat456" },
    ]);
    expect(result.errors).toEqual([]);
  });

  it("parseInstances: dash allowed (team-a)", () => {
    const json = JSON.stringify([
      { id: "team-a", botToken: "bot123", chatId: "chat456" },
    ]);
    const result = telegramAdapter.parseInstances(json);
    expect(result.instances).toEqual([
      { id: "team-a", botToken: "bot123", chatId: "chat456" },
    ]);
    expect(result.errors).toEqual([]);
  });

  it("parseInstances: multiple valid instances", () => {
    const json = JSON.stringify([
      { id: "alerts", botToken: "bot1", chatId: "chat1" },
      { id: "team-a", botToken: "bot2", chatId: "chat2" },
    ]);
    const result = telegramAdapter.parseInstances(json);
    expect(result.instances).toHaveLength(2);
    expect(result.instances[0]?.id).toBe("alerts");
    expect(result.instances[1]?.id).toBe("team-a");
    expect(result.errors).toEqual([]);
  });

  it("parseInstances: 'not json' → invalid JSON error, no instances", () => {
    const result = telegramAdapter.parseInstances("not json");
    expect(result.instances).toEqual([]);
    expect(result.errors).toEqual(["TELEGRAM_INSTANCES: invalid JSON"]);
  });

  it("parseInstances: duplicate id → no instances, duplicate error", () => {
    const json = JSON.stringify([
      { id: "alerts", botToken: "bot1", chatId: "chat1" },
      { id: "alerts", botToken: "bot2", chatId: "chat2" },
    ]);
    const result = telegramAdapter.parseInstances(json);
    expect(result.instances).toEqual([]);
    expect(result.errors).toEqual(["TELEGRAM_INSTANCES: duplicate id 'alerts'"]);
  });

  it("parseInstances: id '-bad' → invalid id error", () => {
    const json = JSON.stringify([
      { id: "-bad", botToken: "bot123", chatId: "chat456" },
    ]);
    const result = telegramAdapter.parseInstances(json);
    expect(result.instances).toEqual([]);
    expect(result.errors).toContain("TELEGRAM_INSTANCES: invalid id '-bad'");
  });

  it("parseInstances: id 'trail-' → invalid id error", () => {
    const json = JSON.stringify([
      { id: "trail-", botToken: "bot123", chatId: "chat456" },
    ]);
    const result = telegramAdapter.parseInstances(json);
    expect(result.instances).toEqual([]);
    expect(result.errors).toContain("TELEGRAM_INSTANCES: invalid id 'trail-'");
  });

  it("parseInstances: id 'bad--id' → invalid id error (consecutive dashes)", () => {
    const json = JSON.stringify([
      { id: "bad--id", botToken: "bot123", chatId: "chat456" },
    ]);
    const result = telegramAdapter.parseInstances(json);
    expect(result.instances).toEqual([]);
    expect(result.errors).toContain("TELEGRAM_INSTANCES: invalid id 'bad--id'");
  });

  it("parseInstances: missing botToken → missing-field error", () => {
    const json = JSON.stringify([
      { id: "alerts", chatId: "chat456" },
    ]);
    const result = telegramAdapter.parseInstances(json);
    expect(result.instances).toEqual([]);
    expect(result.errors).toContain("TELEGRAM_INSTANCES: missing 'botToken' for id 'alerts'");
  });

  it("createProvider returns object with .send", () => {
    const provider = telegramAdapter.createProvider("telegram-alerts", {
      id: "alerts",
      botToken: "bot123",
      chatId: "chat456",
    });
    expect(provider).toHaveProperty("send");
    expect(typeof provider.send).toBe("function");
  });

  it("displayName('alerts') → 'Telegram (alerts)'", () => {
    expect(telegramAdapter.displayName("alerts")).toBe("Telegram (alerts)");
  });
});
