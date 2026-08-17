import { describe, it, expect, mock, beforeEach } from "bun:test";
import { TelegramProvider, telegramAdapter } from "../../src/channels/telegram";
import { serializeChannelRecord } from "../../src/channels/utils";

describe("TelegramProvider (BC6)", () => {
  beforeEach(() => {
    mock.restore();
  });

  it("constructor accepts channelId, botToken, chatId", () => {
    const provider = new TelegramProvider("telegram-alerts", "123:ABC", "chat456");
    expect(provider).toBeDefined();
  });

  it("send text only → success with composite channelId, no parse_mode or disable_web_page_preview", async () => {
    let capturedBody: any;
    const mockFetch = mock((url: string, options?: any) => {
      capturedBody = JSON.parse(options.body);
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
    // text-only must not set parse_mode or disable_web_page_preview
    expect(capturedBody).toEqual({ chat_id: "chat456", text: "Hello" });
    expect("parse_mode" in capturedBody).toBe(false);
    expect("disable_web_page_preview" in capturedBody).toBe(false);
  });

  it("send embed-only → success with HTML body", async () => {
    let capturedBody: any;
    const mockFetch = mock((url: string, options?: any) => {
      capturedBody = JSON.parse(options.body);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            result: { message_id: 789, text: "<b>T</b>", chat: { id: "chat456" } },
          }),
          { status: 200 }
        )
      );
    });
    globalThis.fetch = mockFetch as any;

    const provider = new TelegramProvider("telegram-alerts", "123:ABC", "chat456");
    const result = await provider.send({ embed: { title: "T" } });

    expect(result.success).toBe(true);
    expect(capturedBody.text).toBe("<b>T</b>");
    expect(capturedBody.parse_mode).toBe("HTML");
    expect(capturedBody.disable_web_page_preview).toBe(true);
    expect(capturedBody.chat_id).toBe("chat456");
  });

  it("send combined text+embed → escaped text + rendered embed", async () => {
    let capturedBody: any;
    const mockFetch = mock((url: string, options?: any) => {
      capturedBody = JSON.parse(options.body);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            result: { message_id: 999, text: "x", chat: { id: "chat456" } },
          }),
          { status: 200 }
        )
      );
    });
    globalThis.fetch = mockFetch as any;

    const provider = new TelegramProvider("telegram-alerts", "123:ABC", "chat456");
    const result = await provider.send({
      text: "Heads up <user>",
      embed: { title: "T", description: "D" },
    });

    expect(result.success).toBe(true);
    expect(capturedBody.text).toBe("Heads up &lt;user&gt;\n\n<b>T</b>\nD");
    expect(capturedBody.parse_mode).toBe("HTML");
    expect(capturedBody.disable_web_page_preview).toBe(true);
  });

  it("send neither text nor embed → 'Telegram requires text or embed content'", async () => {
    const provider = new TelegramProvider("telegram-alerts", "123:ABC", "chat456");
    const result = await provider.send({} as any);

    expect(result.success).toBe(false);
    expect(result.channel).toBe("telegram-alerts");
    expect(result.error).toBe("Telegram requires text or embed content");
  });

  it("400 with description 'message is too long' → error contains description (regression)", async () => {
    const mockFetch = mock(() => {
      return Promise.resolve(
        new Response(
          JSON.stringify({ ok: false, error_code: 400, description: "message is too long" }),
          { status: 400 }
        )
      );
    });
    globalThis.fetch = mockFetch as any;

    const provider = new TelegramProvider("telegram-alerts", "123:ABC", "chat456");
    const result = await provider.send({ embed: { title: "Big title" } });

    expect(result.success).toBe(false);
    expect(result.error).toBe("HTTP 400: message is too long");
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

  it("fetch throws TypeError → generic network error (T1)", async () => {
    const mockFetch = mock(() => {
      throw new TypeError("fetch failed");
    });
    globalThis.fetch = mockFetch as any;

    const provider = new TelegramProvider("telegram-alerts", "123:ABC", "chat456");
    const result = await provider.send({ text: "Hello" });

    expect(result.success).toBe(false);
    expect(result.channel).toBe("telegram-alerts");
    expect(result.error).toBe("Network error reaching Telegram");
  });

  it("fetch throws error containing bot token → generic message, no token leak (T2)", async () => {
    const botToken = "123456:ABC-SECRET-TOKEN";
    const mockFetch = mock(() => {
      throw new Error(`connect ECONNREFUSED https://api.telegram.org/bot${botToken}/sendMessage`);
    });
    globalThis.fetch = mockFetch as any;

    const provider = new TelegramProvider("telegram-alerts", botToken, "chat456");
    const result = await provider.send({ text: "Hello" });

    expect(result.success).toBe(false);
    expect(result.channel).toBe("telegram-alerts");
    expect(result.error).toBe("Network error reaching Telegram");
    expect(result.error).not.toContain("123456:ABC-SECRET-TOKEN");
    expect(result.error).not.toContain("api.telegram.org");
  });

  it("fetch throws non-Error value containing raw token → generic message (T3)", async () => {
    const botToken = "123456:ABC-SECRET-TOKEN";
    const mockFetch = mock(() => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw `raw boom ${botToken}`;
    });
    globalThis.fetch = mockFetch as any;

    const provider = new TelegramProvider("telegram-alerts", botToken, "chat456");
    const result = await provider.send({ text: "Hello" });

    expect(result.success).toBe(false);
    expect(result.channel).toBe("telegram-alerts");
    expect(result.error).toBe("Network error reaching Telegram");
    expect(result.error).not.toContain("123456:ABC-SECRET-TOKEN");
  });
});

describe("telegramAdapter (TelegramRecordValidation)", () => {
  it("service === 'telegram'", () => {
    expect(telegramAdapter.service).toBe("telegram");
  });

  it("has no envKey property and no parseInstances method", () => {
    expect("envKey" in telegramAdapter).toBe(false);
    expect("parseInstances" in telegramAdapter).toBe(false);
  });

  it("parseRecord: valid record → ok with config", () => {
    const result = telegramAdapter.parseRecord({
      service: "telegram",
      id: "default",
      botToken: "123:abc",
      chatId: "-1001",
    });
    expect(result).toEqual({
      ok: true,
      config: { id: "default", botToken: "123:abc", chatId: "-1001" },
    });
  });

  it("parseRecord: dashed instance id accepted", () => {
    const result = telegramAdapter.parseRecord({
      service: "telegram",
      id: "team-a",
      botToken: "t",
      chatId: "c",
    });
    expect(result).toEqual({ ok: true, config: { id: "team-a", botToken: "t", chatId: "c" } });
  });

  it("parseRecord: missing botToken → \"missing 'botToken'\"", () => {
    const result = telegramAdapter.parseRecord({ service: "telegram", id: "ops" });
    expect(result).toEqual({ ok: false, error: "missing 'botToken'" });
  });

  it("parseRecord: missing chatId → \"missing 'chatId'\"", () => {
    const result = telegramAdapter.parseRecord({
      service: "telegram",
      id: "ops",
      botToken: "t",
    });
    expect(result).toEqual({ ok: false, error: "missing 'chatId'" });
  });

  it("parseRecord: uppercase id rejected, not lowercased", () => {
    const result = telegramAdapter.parseRecord({
      service: "telegram",
      id: "Ops",
      botToken: "t",
      chatId: "c",
    });
    expect(result).toEqual({ ok: false, error: "invalid id 'Ops'" });
  });

  it("parseRecord: malformed ids rejected ('-bad', 'trail-', 'bad--id')", () => {
    for (const id of ["-bad", "trail-", "bad--id"]) {
      const result = telegramAdapter.parseRecord({
        service: "telegram",
        id,
        botToken: "t",
        chatId: "c",
      });
      expect(result).toEqual({ ok: false, error: `invalid id '${id}'` });
    }
  });

  it("parseRecord: non-string id → missing or invalid 'id'", () => {
    const result = telegramAdapter.parseRecord({
      service: "telegram",
      id: 7,
      botToken: "t",
      chatId: "c",
    });
    expect(result).toEqual({ ok: false, error: "missing or invalid 'id'" });
  });

  it("parseRecord: wrong service → 'service mismatch'", () => {
    const result = telegramAdapter.parseRecord({
      service: "discord",
      id: "ops",
      botToken: "t",
      chatId: "c",
    });
    expect(result).toEqual({ ok: false, error: "service mismatch" });
  });

  it("parseRecord: null → 'record must be an object'", () => {
    expect(telegramAdapter.parseRecord(null)).toEqual({
      ok: false,
      error: "record must be an object",
    });
  });

  it("parseRecord: array / string / number → 'record must be an object'", () => {
    for (const raw of [[], "telegram", 42]) {
      expect(telegramAdapter.parseRecord(raw)).toEqual({
        ok: false,
        error: "record must be an object",
      });
    }
  });

  it("parseRecord: no rejection message mentions INSTANCES (D-M6)", () => {
    const rejects: unknown[] = [
      null,
      [],
      { service: "discord", id: "ops", botToken: "t", chatId: "c" },
      { service: "telegram", id: 7 },
      { service: "telegram", id: "Ops", botToken: "t", chatId: "c" },
      { service: "telegram", id: "ops" },
      { service: "telegram", id: "ops", botToken: "t" },
    ];
    for (const raw of rejects) {
      const result = telegramAdapter.parseRecord(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).not.toContain("INSTANCES");
      }
    }
  });

  it("round-trip: serializeChannelRecord output parses back to ok (ChannelKeyAndRecordFormat)", () => {
    const serialized = serializeChannelRecord("telegram", {
      id: "ops",
      botToken: "t",
      chatId: "c",
    });
    const result = telegramAdapter.parseRecord(JSON.parse(serialized));
    expect(result).toEqual({ ok: true, config: { id: "ops", botToken: "t", chatId: "c" } });
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
