import { describe, it, expect, mock, beforeEach } from "bun:test";
import { DiscordProvider, discordFactory } from "../../src/channels/discord";

describe("DiscordProvider", () => {
  beforeEach(() => {
    // Reset fetch mock before each test
    mock.restore();
  });

  it("send returns success on 204", async () => {
    const mockFetch = mock((url: string, options?: any) => {
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    globalThis.fetch = mockFetch as any;

    const provider = new DiscordProvider(
      "https://discord.com/api/webhooks/123/abc"
    );
    const result = await provider.send("Hello");

    expect(result).toEqual({ success: true, channel: "discord" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      "https://discord.com/api/webhooks/123/abc"
    );
    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body ?? "{}");
    expect(body).toEqual({ content: "Hello", username: "Dovecote" });
  });

  it("send returns failure on non-ok response", async () => {
    const mockFetch = mock(() => {
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    });
    globalThis.fetch = mockFetch as any;

    const provider = new DiscordProvider(
      "https://discord.com/api/webhooks/123/abc"
    );
    const result = await provider.send("Hello");

    expect(result.success).toBe(false);
    expect(result.channel).toBe("discord");
    expect(result.error).toContain("404");
  });

  it("send returns failure on network error", async () => {
    const mockFetch = mock(() => {
      throw new Error("Network error");
    });
    globalThis.fetch = mockFetch as any;

    const provider = new DiscordProvider(
      "https://discord.com/api/webhooks/123/abc"
    );
    const result = await provider.send("Hello");

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
