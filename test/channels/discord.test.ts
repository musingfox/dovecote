import { describe, it, expect, mock, beforeEach } from "bun:test";
import { DiscordProvider, discordAdapter } from "../../src/channels/discord";
import { serializeChannelRecord } from "../../src/channels/utils";

describe("DiscordProvider (BC7)", () => {
  beforeEach(() => {
    mock.restore();
  });

  it("constructor accepts channelId, webhookUrl", () => {
    const provider = new DiscordProvider(
      "discord-team-a",
      "https://discord.com/api/webhooks/123/abc"
    );
    expect(provider).toBeDefined();
  });

  it("send text only → success with composite channelId", async () => {
    const mockFetch = mock((url: string, options?: any) => {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "msg-001",
            content: "Hello",
            channel_id: "ch-123",
          }),
          { status: 200 }
        )
      );
    });
    globalThis.fetch = mockFetch as any;

    const provider = new DiscordProvider(
      "discord-team-a",
      "https://discord.com/api/webhooks/123/abc"
    );
    const result = await provider.send({ text: "Hello" });

    expect(result).toEqual({
      success: true,
      channel: "discord-team-a",
      messageId: "msg-001",
      detail: { text: "Hello", chatId: "ch-123" },
    });
  });

  it("send with attachment → POSTs multipart with payload_json + files[0]", async () => {
    let capturedBody: any;
    let capturedOptions: any;
    const mockFetch = mock((url: string, options?: any) => {
      capturedOptions = options;
      capturedBody = options?.body;
      return Promise.resolve(
        new Response(
          JSON.stringify({ id: "msg-img", content: "", channel_id: "ch-123" }),
          { status: 200 }
        )
      );
    });
    globalThis.fetch = mockFetch as any;

    const provider = new DiscordProvider(
      "discord-team-a",
      "https://discord.com/api/webhooks/123/abc"
    );
    // "aGVsbG8=" is base64 for "hello"
    const result = await provider.send({
      embed: { image: { url: "attachment://chart.png" } },
      attachment: { filename: "chart.png", data: "aGVsbG8=", contentType: "image/png" },
    });

    expect(result.success).toBe(true);
    expect(capturedBody).toBeInstanceOf(FormData);
    // No manually-set Content-Type → fetch supplies the multipart boundary.
    expect(capturedOptions.headers).toBeUndefined();
    expect(capturedOptions.redirect).toBe("manual");

    const payloadJson = capturedBody.get("payload_json");
    expect(typeof payloadJson).toBe("string");
    const parsed = JSON.parse(payloadJson);
    expect(parsed.embeds[0].image.url).toBe("attachment://chart.png");
    expect(parsed.username).toBe("Dovecote");

    const file = capturedBody.get("files[0]");
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe("chart.png");
    expect((file as Blob).type).toBe("image/png");
    expect(await (file as Blob).text()).toBe("hello");
  });

  it("send without attachment → still JSON (no regression)", async () => {
    let capturedBody: any;
    let capturedOptions: any;
    const mockFetch = mock((url: string, options?: any) => {
      capturedOptions = options;
      capturedBody = options?.body;
      return Promise.resolve(
        new Response(
          JSON.stringify({ id: "msg-001", content: "Hi", channel_id: "ch-123" }),
          { status: 200 }
        )
      );
    });
    globalThis.fetch = mockFetch as any;

    const provider = new DiscordProvider(
      "discord-team-a",
      "https://discord.com/api/webhooks/123/abc"
    );
    await provider.send({ text: "Hi" });

    expect(capturedBody).not.toBeInstanceOf(FormData);
    expect(typeof capturedBody).toBe("string");
    expect(capturedOptions.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(capturedBody).content).toBe("Hi");
  });

  it("send returns HTTP 404 error", async () => {
    const mockFetch = mock(() => {
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    });
    globalThis.fetch = mockFetch as any;

    const provider = new DiscordProvider(
      "discord-team-a",
      "https://discord.com/api/webhooks/123/abc"
    );
    const result = await provider.send({ text: "Hello" });

    expect(result.success).toBe(false);
    expect(result.channel).toBe("discord-team-a");
    expect(result.error).toContain("HTTP 404");
  });

  it("send includes redirect: manual in fetch options (BC-SSRF3)", async () => {
    let capturedOptions: any;
    const mockFetch = mock((url: string, options?: any) => {
      capturedOptions = options;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "msg-001",
            content: "test",
            channel_id: "ch-123",
          }),
          { status: 200 }
        )
      );
    });
    globalThis.fetch = mockFetch as any;

    const provider = new DiscordProvider(
      "discord-team-a",
      "https://discord.com/api/webhooks/123/abc"
    );
    await provider.send({ text: "test" });

    expect(mockFetch).toHaveBeenCalled();
    expect(capturedOptions).toHaveProperty("redirect");
    expect(capturedOptions.redirect).toBe("manual");
  });

  it("3xx response treated as failure (BC-SSRF3)", async () => {
    const mockFetch = mock(() => {
      return Promise.resolve(
        new Response(null, { status: 302, headers: { Location: "https://evil.example/" } })
      );
    });
    globalThis.fetch = mockFetch as any;

    const provider = new DiscordProvider(
      "discord-team-a",
      "https://discord.com/api/webhooks/123/abc"
    );
    const result = await provider.send({ text: "test" });

    expect(result.success).toBe(false);
    expect(result.channel).toBe("discord-team-a");
    expect(result.error).toContain("HTTP 302");
    expect(result.error).toContain("unexpected redirect");
  });

  it("fetch throws TypeError → generic network error (T4)", async () => {
    const mockFetch = mock(() => {
      throw new TypeError("fetch failed");
    });
    globalThis.fetch = mockFetch as any;

    const provider = new DiscordProvider(
      "discord-team-a",
      "https://discord.com/api/webhooks/123/abc"
    );
    const result = await provider.send({ text: "test" });

    expect(result).toEqual({
      success: false,
      channel: "discord-team-a",
      error: "Network error reaching Discord",
    });
  });

  it("fetch throws error containing webhook URL → generic message, no token leak (T5)", async () => {
    const webhookUrl = "https://discord.com/api/webhooks/999/SECRET-WEBHOOK-TOKEN";
    const mockFetch = mock(() => {
      throw new Error(`network down: ${webhookUrl}`);
    });
    globalThis.fetch = mockFetch as any;

    const provider = new DiscordProvider("discord-team-a", webhookUrl);
    const result = await provider.send({ text: "test" });

    expect(result.success).toBe(false);
    expect(result.channel).toBe("discord-team-a");
    expect(result.error).toBe("Network error reaching Discord");
    expect(result.error).not.toContain("SECRET-WEBHOOK-TOKEN");
    expect(result.error).not.toContain("discord.com/api/webhooks");
  });

  it("fetch throws non-Error value → generic message (T6)", async () => {
    const mockFetch = mock(() => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw { toString: () => "https://discord.com/api/webhooks/999/SECRET" };
    });
    globalThis.fetch = mockFetch as any;

    const provider = new DiscordProvider(
      "discord-team-a",
      "https://discord.com/api/webhooks/999/SECRET"
    );
    const result = await provider.send({ text: "test" });

    expect(result.success).toBe(false);
    expect(result.channel).toBe("discord-team-a");
    expect(result.error).toBe("Network error reaching Discord");
  });

  it("JSON with message field → extract message (BC-SANITIZE-DISCORD)", async () => {
    const mockFetch = mock(() => {
      return Promise.resolve(
        new Response(
          JSON.stringify({ message: "Unknown Webhook", code: 10015 }),
          { status: 404 }
        )
      );
    });
    globalThis.fetch = mockFetch as any;

    const provider = new DiscordProvider(
      "discord-team-a",
      "https://discord.com/api/webhooks/123/abc"
    );
    const result = await provider.send({ text: "Hello" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("HTTP 404: Unknown Webhook");
  });

  it("non-JSON short → use raw text (BC-SANITIZE-DISCORD)", async () => {
    const mockFetch = mock(() => {
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    });
    globalThis.fetch = mockFetch as any;

    const provider = new DiscordProvider(
      "discord-team-a",
      "https://discord.com/api/webhooks/123/abc"
    );
    const result = await provider.send({ text: "Hello" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("HTTP 404: Not Found");
  });

  it("non-JSON long → truncate to 100 chars + '...' (BC-SANITIZE-DISCORD)", async () => {
    const mockFetch = mock(() => {
      return Promise.resolve(new Response("B".repeat(200), { status: 500 }));
    });
    globalThis.fetch = mockFetch as any;

    const provider = new DiscordProvider(
      "discord-team-a",
      "https://discord.com/api/webhooks/123/abc"
    );
    const result = await provider.send({ text: "Hello" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("HTTP 500: " + "B".repeat(100) + "...");
  });

  it("JSON without message → use raw JSON (BC-SANITIZE-DISCORD)", async () => {
    const mockFetch = mock(() => {
      return Promise.resolve(
        new Response(
          JSON.stringify({ retry_after: 5.0, global: false }),
          { status: 429 }
        )
      );
    });
    globalThis.fetch = mockFetch as any;

    const provider = new DiscordProvider(
      "discord-team-a",
      "https://discord.com/api/webhooks/123/abc"
    );
    const result = await provider.send({ text: "Hello" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("HTTP 429:");
    expect(result.error).toContain("retry_after");
  });
});

describe("discordAdapter (DiscordRecordValidation)", () => {
  it("service === 'discord'", () => {
    expect(discordAdapter.service).toBe("discord");
  });

  it("has no envKey property and no parseInstances method", () => {
    expect("envKey" in discordAdapter).toBe(false);
    expect("parseInstances" in discordAdapter).toBe(false);
  });

  it("parseRecord: valid record → ok with config", () => {
    const result = discordAdapter.parseRecord({
      service: "discord",
      id: "ops",
      webhookUrl: "https://discord.com/api/webhooks/1/tok",
    });
    expect(result).toEqual({
      ok: true,
      config: { id: "ops", webhookUrl: "https://discord.com/api/webhooks/1/tok" },
    });
  });

  it("parseRecord: dashed instance id accepted", () => {
    const result = discordAdapter.parseRecord({
      service: "discord",
      id: "team-a",
      webhookUrl: "https://discord.com/api/webhooks/1/tok",
    });
    expect(result).toEqual({
      ok: true,
      config: { id: "team-a", webhookUrl: "https://discord.com/api/webhooks/1/tok" },
    });
  });

  it("parseRecord: non-Discord host → 'invalid webhookUrl' (SSRF allowlist preserved)", () => {
    const result = discordAdapter.parseRecord({
      service: "discord",
      id: "ops",
      webhookUrl: "https://evil.example/api/webhooks/1/tok",
    });
    expect(result).toEqual({ ok: false, error: "invalid webhookUrl" });
  });

  it("parseRecord: http webhook URL → 'invalid webhookUrl'", () => {
    const result = discordAdapter.parseRecord({
      service: "discord",
      id: "ops",
      webhookUrl: "http://discord.com/api/webhooks/1/tok",
    });
    expect(result).toEqual({ ok: false, error: "invalid webhookUrl" });
  });

  it("parseRecord: missing webhookUrl → \"missing 'webhookUrl'\"", () => {
    const result = discordAdapter.parseRecord({ service: "discord", id: "ops" });
    expect(result).toEqual({ ok: false, error: "missing 'webhookUrl'" });
  });

  it("parseRecord: uppercase id rejected, not lowercased", () => {
    const result = discordAdapter.parseRecord({
      service: "discord",
      id: "Ops",
      webhookUrl: "https://discord.com/api/webhooks/1/tok",
    });
    expect(result).toEqual({ ok: false, error: "invalid id 'Ops'" });
  });

  it("parseRecord: malformed ids rejected ('-bad', 'trail-', 'bad--id')", () => {
    for (const id of ["-bad", "trail-", "bad--id"]) {
      const result = discordAdapter.parseRecord({
        service: "discord",
        id,
        webhookUrl: "https://discord.com/api/webhooks/1/tok",
      });
      expect(result).toEqual({ ok: false, error: `invalid id '${id}'` });
    }
  });

  it("parseRecord: non-string id → missing or invalid 'id'", () => {
    const result = discordAdapter.parseRecord({
      service: "discord",
      id: 7,
      webhookUrl: "https://discord.com/api/webhooks/1/tok",
    });
    expect(result).toEqual({ ok: false, error: "missing or invalid 'id'" });
  });

  it("parseRecord: wrong service → 'service mismatch'", () => {
    const result = discordAdapter.parseRecord({
      service: "telegram",
      id: "ops",
      webhookUrl: "https://discord.com/api/webhooks/1/t",
    });
    expect(result).toEqual({ ok: false, error: "service mismatch" });
  });

  it("parseRecord: null / array / string → 'record must be an object'", () => {
    for (const raw of [null, [], "discord"]) {
      expect(discordAdapter.parseRecord(raw)).toEqual({
        ok: false,
        error: "record must be an object",
      });
    }
  });

  it("parseRecord: no rejection message mentions INSTANCES (D-M6)", () => {
    const rejects: unknown[] = [
      null,
      [],
      { service: "telegram", id: "ops", webhookUrl: "https://discord.com/api/webhooks/1/t" },
      { service: "discord", id: 7 },
      { service: "discord", id: "Ops", webhookUrl: "https://discord.com/api/webhooks/1/t" },
      { service: "discord", id: "ops" },
      { service: "discord", id: "ops", webhookUrl: "https://evil.example/api/webhooks/1/t" },
    ];
    for (const raw of rejects) {
      const result = discordAdapter.parseRecord(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).not.toContain("INSTANCES");
      }
    }
  });

  it("round-trip: serializeChannelRecord output parses back to ok", () => {
    const serialized = serializeChannelRecord("discord", {
      id: "ops",
      webhookUrl: "https://discord.com/api/webhooks/1/tok",
    });
    const result = discordAdapter.parseRecord(JSON.parse(serialized));
    expect(result).toEqual({
      ok: true,
      config: { id: "ops", webhookUrl: "https://discord.com/api/webhooks/1/tok" },
    });
  });

  it("createProvider returns object with .send", () => {
    const provider = discordAdapter.createProvider("discord-team-a", {
      id: "team-a",
      webhookUrl: "https://discord.com/api/webhooks/123/abc",
    });
    expect(provider).toHaveProperty("send");
    expect(typeof provider.send).toBe("function");
  });

  it("displayName('team-a') → 'Discord (team-a)'", () => {
    expect(discordAdapter.displayName("team-a")).toBe("Discord (team-a)");
  });
});
