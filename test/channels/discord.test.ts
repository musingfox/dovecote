import { describe, it, expect, mock, beforeEach } from "bun:test";
import { DiscordProvider, discordAdapter } from "../../src/channels/discord";

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

describe("discordAdapter (BC2, BC8)", () => {
  it("service === 'discord'", () => {
    expect(discordAdapter.service).toBe("discord");
  });

  it("envKey === 'DISCORD_INSTANCES'", () => {
    expect(discordAdapter.envKey).toBe("DISCORD_INSTANCES");
  });

  it("parseInstances: undefined → empty, no errors", () => {
    const result = discordAdapter.parseInstances(undefined);
    expect(result).toEqual({ instances: [], errors: [] });
  });

  it("parseInstances: empty string → empty, no errors", () => {
    const result = discordAdapter.parseInstances("");
    expect(result).toEqual({ instances: [], errors: [] });
  });

  it("parseInstances: valid single instance", () => {
    const json = JSON.stringify([
      { id: "team-a", webhookUrl: "https://discord.com/api/webhooks/123/abc" },
    ]);
    const result = discordAdapter.parseInstances(json);
    expect(result.instances).toEqual([
      { id: "team-a", webhookUrl: "https://discord.com/api/webhooks/123/abc" },
    ]);
    expect(result.errors).toEqual([]);
  });

  it("parseInstances: id lowercased", () => {
    const json = JSON.stringify([
      { id: "TeamA", webhookUrl: "https://discord.com/api/webhooks/123/abc" },
    ]);
    const result = discordAdapter.parseInstances(json);
    expect(result.instances).toEqual([
      { id: "teama", webhookUrl: "https://discord.com/api/webhooks/123/abc" },
    ]);
  });

  it("parseInstances: dash allowed (my-bot)", () => {
    const json = JSON.stringify([
      { id: "my-bot", webhookUrl: "https://discord.com/api/webhooks/123/abc" },
    ]);
    const result = discordAdapter.parseInstances(json);
    expect(result.instances).toEqual([
      { id: "my-bot", webhookUrl: "https://discord.com/api/webhooks/123/abc" },
    ]);
    expect(result.errors).toEqual([]);
  });

  it("parseInstances: dash allowed (team-a)", () => {
    const json = JSON.stringify([
      { id: "team-a", webhookUrl: "https://discord.com/api/webhooks/123/abc" },
    ]);
    const result = discordAdapter.parseInstances(json);
    expect(result.instances).toEqual([
      { id: "team-a", webhookUrl: "https://discord.com/api/webhooks/123/abc" },
    ]);
    expect(result.errors).toEqual([]);
  });

  it("parseInstances: multiple valid instances", () => {
    const json = JSON.stringify([
      { id: "team-a", webhookUrl: "https://discord.com/api/webhooks/1/a" },
      { id: "team-b", webhookUrl: "https://discord.com/api/webhooks/2/b" },
    ]);
    const result = discordAdapter.parseInstances(json);
    expect(result.instances).toHaveLength(2);
    expect(result.instances[0]?.id).toBe("team-a");
    expect(result.instances[1]?.id).toBe("team-b");
    expect(result.errors).toEqual([]);
  });

  it("parseInstances: 'not json' → invalid JSON error, no instances", () => {
    const result = discordAdapter.parseInstances("not json");
    expect(result.instances).toEqual([]);
    expect(result.errors).toEqual(["DISCORD_INSTANCES: invalid JSON"]);
  });

  it("parseInstances: duplicate id → no instances, duplicate error", () => {
    const json = JSON.stringify([
      { id: "team-a", webhookUrl: "https://discord.com/api/webhooks/1/a" },
      { id: "team-a", webhookUrl: "https://discord.com/api/webhooks/2/b" },
    ]);
    const result = discordAdapter.parseInstances(json);
    expect(result.instances).toEqual([]);
    expect(result.errors).toEqual(["DISCORD_INSTANCES: duplicate id 'team-a'"]);
  });

  it("parseInstances: id '-bad' → invalid id error", () => {
    const json = JSON.stringify([
      { id: "-bad", webhookUrl: "https://discord.com/api/webhooks/123/abc" },
    ]);
    const result = discordAdapter.parseInstances(json);
    expect(result.instances).toEqual([]);
    expect(result.errors).toContain("DISCORD_INSTANCES: invalid id '-bad'");
  });

  it("parseInstances: id 'trail-' → invalid id error", () => {
    const json = JSON.stringify([
      { id: "trail-", webhookUrl: "https://discord.com/api/webhooks/123/abc" },
    ]);
    const result = discordAdapter.parseInstances(json);
    expect(result.instances).toEqual([]);
    expect(result.errors).toContain("DISCORD_INSTANCES: invalid id 'trail-'");
  });

  it("parseInstances: id 'bad--id' → invalid id error (consecutive dashes)", () => {
    const json = JSON.stringify([
      { id: "bad--id", webhookUrl: "https://discord.com/api/webhooks/123/abc" },
    ]);
    const result = discordAdapter.parseInstances(json);
    expect(result.instances).toEqual([]);
    expect(result.errors).toContain("DISCORD_INSTANCES: invalid id 'bad--id'");
  });

  it("parseInstances: missing webhookUrl → missing-field error", () => {
    const json = JSON.stringify([
      { id: "team-a" },
    ]);
    const result = discordAdapter.parseInstances(json);
    expect(result.instances).toEqual([]);
    expect(result.errors).toContain("DISCORD_INSTANCES: missing 'webhookUrl' for id 'team-a'");
  });

  it("parseInstances: http webhook URL rejected (BC-SSRF2)", () => {
    const json = JSON.stringify([
      { id: "bad", webhookUrl: "http://discord.com/api/webhooks/1/t" },
    ]);
    const result = discordAdapter.parseInstances(json);
    expect(result.instances).toEqual([]);
    expect(result.errors).toContain("DISCORD_INSTANCES: invalid webhookUrl for id 'bad'");
  });

  it("parseInstances: evil.com webhook URL rejected (BC-SSRF2)", () => {
    const json = JSON.stringify([
      { id: "bad", webhookUrl: "https://evil.com/api/webhooks/1/t" },
    ]);
    const result = discordAdapter.parseInstances(json);
    expect(result.instances).toEqual([]);
    expect(result.errors).toContain("DISCORD_INSTANCES: invalid webhookUrl for id 'bad'");
  });

  it("parseInstances: mixed valid+invalid webhooks (BC-SSRF2)", () => {
    const json = JSON.stringify([
      { id: "good", webhookUrl: "https://discord.com/api/webhooks/123/abc" },
      { id: "bad", webhookUrl: "https://localhost/api/webhooks/1/t" },
    ]);
    const result = discordAdapter.parseInstances(json);
    expect(result.instances).toEqual([
      { id: "good", webhookUrl: "https://discord.com/api/webhooks/123/abc" },
    ]);
    expect(result.errors).toContain("DISCORD_INSTANCES: invalid webhookUrl for id 'bad'");
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
