import { describe, it, expect } from "bun:test";
import { messageContentSchema, discordEmbedSchema } from "../../src/channels/schemas";

describe("messageContentSchema (BC1)", () => {
  it("validates text only", () => {
    const result = messageContentSchema.safeParse({
      text: "Hello",
    });
    expect(result.success).toBe(true);
  });

  it("validates embed only", () => {
    const result = messageContentSchema.safeParse({
      embed: { title: "Alert" },
    });
    expect(result.success).toBe(true);
  });

  it("validates both text and embed", () => {
    const result = messageContentSchema.safeParse({
      text: "See embed",
      embed: { title: "Details" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty content", () => {
    const result = messageContentSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors[0]?.message).toBe(
        "At least one of text or embed is required"
      );
    }
  });

  it("rejects invalid embed color type", () => {
    const result = messageContentSchema.safeParse({
      embed: { color: "red" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const errorMessage = JSON.stringify(result.error.errors);
      expect(errorMessage).toContain("color");
    }
  });
});

describe("discordEmbedSchema (BC2)", () => {
  it("validates minimal embed", () => {
    const result = discordEmbedSchema.safeParse({
      title: "Test",
    });
    expect(result.success).toBe(true);
  });

  it("validates full embed structure", () => {
    const result = discordEmbedSchema.safeParse({
      title: "Alert",
      description: "System down",
      url: "https://status.example.com",
      color: 0xff0000,
      timestamp: "2026-04-12T10:00:00Z",
      footer: { text: "Dovecote", icon_url: "https://example.com/icon.png" },
      image: { url: "https://example.com/chart.png" },
      thumbnail: { url: "https://example.com/thumb.png" },
      author: {
        name: "Monitor",
        url: "https://example.com",
        icon_url: "https://example.com/author.png",
      },
      fields: [
        { name: "Status", value: "Critical", inline: true },
        { name: "Region", value: "US-East", inline: true },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects color as string", () => {
    const result = discordEmbedSchema.safeParse({
      title: "Test",
      color: "#ff0000",
    });
    expect(result.success).toBe(false);
  });

  it("rejects color outside valid range", () => {
    const result = discordEmbedSchema.safeParse({
      title: "Test",
      color: 0x1000000,
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid timestamp format", () => {
    const result = discordEmbedSchema.safeParse({
      title: "Test",
      timestamp: "2026-04-12",
    });
    expect(result.success).toBe(false);
  });
});
