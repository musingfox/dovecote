import { test, expect } from "bun:test";
import {
  discordEmbedSchema,
  messageContentSchema,
} from "../../src/contracts/notifications.js";
import type { DiscordEmbed, MessageContent } from "../../src/contracts/notifications.js";
import {
  discordEmbedSchema as legacyDiscordEmbedSchema,
  messageContentSchema as legacyMessageContentSchema,
} from "../../src/channels/schemas.js";

test("A1: discordEmbedSchema validates Discord-shaped objects", () => {
  // Valid: minimal embed
  const result1 = discordEmbedSchema.safeParse({ title: "Test" });
  expect(result1.success).toBe(true);

  // Valid: full embed structure
  const result2 = discordEmbedSchema.safeParse({
    title: "Alert",
    description: "System down",
    url: "https://status.example.com",
    timestamp: "2026-04-12T10:00:00Z",
    color: 0xff0000,
    footer: { text: "Dovecote" },
    image: { url: "https://example.com/chart.png" },
    thumbnail: { url: "https://example.com/thumb.png" },
    author: { name: "Monitor" },
    fields: [{ name: "Status", value: "Critical", inline: true }],
  });
  expect(result2.success).toBe(true);

  // Invalid: color as string
  const result3 = discordEmbedSchema.safeParse({
    title: "Test",
    color: "#ff0000",
  });
  expect(result3.success).toBe(false);

  // Invalid: color outside valid range (>0xffffff)
  const result4 = discordEmbedSchema.safeParse({
    title: "Test",
    color: 0x1000000,
  });
  expect(result4.success).toBe(false);

  // Invalid: timestamp not ISO datetime
  const result5 = discordEmbedSchema.safeParse({
    title: "Test",
    timestamp: "2026-04-12",
  });
  expect(result5.success).toBe(false);
});

test("A1: discordEmbedSchema reference equality with legacy import", () => {
  // Both imports should return the same schema instance
  expect(discordEmbedSchema).toBe(legacyDiscordEmbedSchema);
});

test("A2: messageContentSchema enforces text-or-embed presence", () => {
  // Valid: text only
  const result1 = messageContentSchema.safeParse({ text: "Hello" });
  expect(result1.success).toBe(true);

  // Valid: embed only
  const result2 = messageContentSchema.safeParse({ embed: { title: "X" } });
  expect(result2.success).toBe(true);

  // Valid: both text and embed
  const result3 = messageContentSchema.safeParse({ text: "a", embed: { title: "X" } });
  expect(result3.success).toBe(true);

  // Invalid: empty object
  const result4 = messageContentSchema.safeParse({});
  expect(result4.success).toBe(false);
  if (!result4.success) {
    expect(result4.error.errors[0]?.message).toBe("At least one of text or embed is required");
  }
});

test("A2: messageContentSchema reference equality with legacy import", () => {
  // Both imports should return the same schema instance
  expect(messageContentSchema).toBe(legacyMessageContentSchema);
});

test("A2: DiscordEmbed type is exported", () => {
  const embed: DiscordEmbed = {
    title: "Test",
    color: 0xff0000,
  };
  expect(embed.title).toBe("Test");
});

test("A2: MessageContent type is exported", () => {
  const content: MessageContent = {
    text: "Hello",
    embed: { title: "Embed" },
  };
  expect(content.text).toBe("Hello");
});
