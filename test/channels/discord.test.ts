import { describe, it, expect, mock, beforeEach } from "bun:test";
import { DiscordProvider, discordFactory } from "../../src/channels/discord";

describe("DiscordProvider (BC3)", () => {
  beforeEach(() => {
    // Reset fetch mock before each test
    mock.restore();
  });

  it("send text only → sends { content, username }", async () => {
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
      "https://discord.com/api/webhooks/123/abc"
    );
    const result = await provider.send({ text: "Hello" });

    expect(result).toEqual({
      success: true,
      channel: "discord",
      messageId: "msg-001",
      detail: { text: "Hello", chatId: "ch-123" },
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      "https://discord.com/api/webhooks/123/abc?wait=true"
    );
    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body ?? "{}");
    expect(body).toEqual({ content: "Hello", username: "Dovecote" });
  });

  it("send embed only → sends { embeds: [...], username }", async () => {
    const mockFetch = mock((url: string, options?: any) => {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "msg-002",
            embeds: [{ title: "Alert", description: "Issue" }],
            channel_id: "ch-123",
          }),
          { status: 200 }
        )
      );
    });
    globalThis.fetch = mockFetch as any;

    const provider = new DiscordProvider(
      "https://discord.com/api/webhooks/123/abc"
    );
    const result = await provider.send({
      embed: { title: "Alert", description: "Issue" },
    });

    expect(result.success).toBe(true);
    expect(result.channel).toBe("discord");
    expect(result.messageId).toBe("msg-002");
    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body ?? "{}");
    expect(body.embeds).toEqual([{ title: "Alert", description: "Issue" }]);
    expect(body.username).toBe("Dovecote");
    expect(body.content).toBeUndefined();
  });

  it("send both text and embed → sends { content, embeds: [...], username }", async () => {
    const mockFetch = mock((url: string, options?: any) => {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "msg-003",
            content: "Check this",
            embeds: [{ title: "Report" }],
            channel_id: "ch-123",
          }),
          { status: 200 }
        )
      );
    });
    globalThis.fetch = mockFetch as any;

    const provider = new DiscordProvider(
      "https://discord.com/api/webhooks/123/abc"
    );
    const result = await provider.send({
      text: "Check this",
      embed: { title: "Report" },
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe("msg-003");
    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body ?? "{}");
    expect(body.content).toBe("Check this");
    expect(body.embeds).toEqual([{ title: "Report" }]);
    expect(body.username).toBe("Dovecote");
  });

  it("send returns failure on HTTP 404", async () => {
    const mockFetch = mock(() => {
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    });
    globalThis.fetch = mockFetch as any;

    const provider = new DiscordProvider(
      "https://discord.com/api/webhooks/123/abc"
    );
    const result = await provider.send({ text: "Hello" });

    expect(result.success).toBe(false);
    expect(result.channel).toBe("discord");
    expect(result.error).toContain("HTTP 404");
  });

  it("send returns failure on network error", async () => {
    const mockFetch = mock(() => {
      throw new Error("Network error");
    });
    globalThis.fetch = mockFetch as any;

    const provider = new DiscordProvider(
      "https://discord.com/api/webhooks/123/abc"
    );
    const result = await provider.send({ text: "Hello" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Network error");
  });
});

describe("discordFactory", () => {
  it("create returns provider when env var set", () => {
    const env = {
      MCP_AUTH_TOKEN: "x",
      DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/abc",
    };
    expect(discordFactory.create(env as any)).not.toBeNull();
  });

  it("create returns null when env var missing", () => {
    const env = { MCP_AUTH_TOKEN: "x" };
    expect(discordFactory.create(env as any)).toBeNull();
  });

  it("getConfig returns enabled true when configured", () => {
    const env = {
      MCP_AUTH_TOKEN: "x",
      DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/abc",
    };
    expect(discordFactory.getConfig(env as any)).toEqual({
      id: "discord",
      name: "Discord",
      enabled: true,
    });
  });

  it("getConfig returns enabled false when not configured", () => {
    const env = { MCP_AUTH_TOKEN: "x" };
    expect(discordFactory.getConfig(env as any)).toEqual({
      id: "discord",
      name: "Discord",
      enabled: false,
    });
  });
});
