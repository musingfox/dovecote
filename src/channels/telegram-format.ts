import type { DiscordEmbed } from "./types.js";

/**
 * Escape a string for Telegram HTML parse_mode.
 * & escaped first to keep the function order-stable.
 * " escaped so URLs interpolated into href="..." cannot break out of the attribute.
 */
export function escapeTelegramHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Convert a DiscordEmbed to a Telegram HTML string.
 * Returns "" if the embed has no renderable fields.
 * Dropped silently: color, timestamp, footer, image, thumbnail, author.
 */
export function renderEmbedAsHtml(embed: DiscordEmbed): string {
  const parts: string[] = [];

  // Title + URL block
  if (embed.title !== undefined && embed.url !== undefined) {
    parts.push(`<b><a href="${escapeTelegramHtml(embed.url)}">${escapeTelegramHtml(embed.title)}</a></b>`);
  } else if (embed.title !== undefined) {
    parts.push(`<b>${escapeTelegramHtml(embed.title)}</b>`);
  } else if (embed.url !== undefined) {
    parts.push(`<a href="${escapeTelegramHtml(embed.url)}">${escapeTelegramHtml(embed.url)}</a>`);
  }

  // Description: join to header with single \n
  if (embed.description !== undefined) {
    if (parts.length > 0) {
      parts[parts.length - 1] += "\n" + escapeTelegramHtml(embed.description);
    } else {
      parts.push(escapeTelegramHtml(embed.description));
    }
  }

  // Fields: each separated by \n\n from previous
  if (embed.fields !== undefined) {
    for (const field of embed.fields) {
      parts.push(`<b>${escapeTelegramHtml(field.name)}</b>\n${escapeTelegramHtml(field.value)}`);
    }
  }

  return parts.join("\n\n");
}
