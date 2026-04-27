import type { SendResult } from "../types.js";
import type { ChannelProvider, MessageContent, ServiceAdapter, TelegramInstanceConfig } from "./types.js";
import { isValidInstanceId } from "./utils.js";
import { escapeTelegramHtml, renderEmbedAsHtml } from "./telegram-format.js";

const MAX_ERROR_DETAIL = 100;

export class TelegramProvider implements ChannelProvider {
  constructor(
    private channelId: string,
    private botToken: string,
    private chatId: string
  ) {}

  async send(content: MessageContent): Promise<SendResult> {
    const hasText = content.text !== undefined;
    const hasEmbed = content.embed !== undefined;

    if (!hasText && !hasEmbed) {
      return {
        success: false,
        channel: this.channelId,
        error: "Telegram requires text or embed content",
      };
    }

    let body: Record<string, unknown>;

    if (hasText && !hasEmbed) {
      // text-only: no parse_mode, no disable_web_page_preview
      body = {
        chat_id: this.chatId,
        text: content.text,
      };
    } else if (!hasText && hasEmbed) {
      // embed-only
      body = {
        chat_id: this.chatId,
        text: renderEmbedAsHtml(content.embed!),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      };
    } else {
      // text + embed
      body = {
        chat_id: this.chatId,
        text: escapeTelegramHtml(content.text!) + "\n\n" + renderEmbedAsHtml(content.embed!),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      };
    }

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        let detail = text;
        try {
          const parsed = JSON.parse(text);
          if (typeof parsed === "object" && parsed !== null && typeof parsed.description === "string") {
            detail = parsed.description;
          }
        } catch {
        }
        if (detail.length > MAX_ERROR_DETAIL) {
          detail = detail.slice(0, MAX_ERROR_DETAIL) + "...";
        }
        return {
          success: false,
          channel: this.channelId,
          error: `HTTP ${response.status}: ${detail}`,
        };
      }

      const data = (await response.json()) as any;
      if (data.ok && data.result?.message_id) {
        return {
          success: true,
          channel: this.channelId,
          messageId: String(data.result.message_id),
          detail: {
            text: data.result.text,
            chatId: String(data.result.chat?.id),
          },
        };
      }

      return {
        success: false,
        channel: this.channelId,
        error: "Unexpected response format",
      };
    } catch {
      return {
        success: false,
        channel: this.channelId,
        error: "Network error reaching Telegram",
      };
    }
  }
}

export const telegramAdapter: ServiceAdapter<TelegramInstanceConfig> = {
  service: "telegram",
  envKey: "TELEGRAM_INSTANCES",

  parseInstances(json: string | undefined): { instances: TelegramInstanceConfig[]; errors: string[] } {
    if (json === undefined || json === "") {
      return { instances: [], errors: [] };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { instances: [], errors: ["TELEGRAM_INSTANCES: invalid JSON"] };
    }

    if (!Array.isArray(parsed)) {
      return { instances: [], errors: ["TELEGRAM_INSTANCES: expected array"] };
    }

    const instances: TelegramInstanceConfig[] = [];
    const errors: string[] = [];
    const seenIds = new Set<string>();

    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) {
        errors.push("TELEGRAM_INSTANCES: entry must be object");
        continue;
      }

      const { id, botToken, chatId } = entry as Record<string, unknown>;

      if (typeof id !== "string") {
        errors.push("TELEGRAM_INSTANCES: missing or invalid 'id'");
        continue;
      }

      const normalizedId = id.toLowerCase();

      if (!isValidInstanceId(normalizedId)) {
        errors.push(`TELEGRAM_INSTANCES: invalid id '${id}'`);
        continue;
      }

      if (typeof botToken !== "string") {
        errors.push(`TELEGRAM_INSTANCES: missing 'botToken' for id '${id}'`);
        continue;
      }

      if (typeof chatId !== "string") {
        errors.push(`TELEGRAM_INSTANCES: missing 'chatId' for id '${id}'`);
        continue;
      }

      if (seenIds.has(normalizedId)) {
        return { instances: [], errors: [`TELEGRAM_INSTANCES: duplicate id '${id}'`] };
      }

      seenIds.add(normalizedId);
      instances.push({ id: normalizedId, botToken, chatId });
    }

    return { instances, errors };
  },

  createProvider(channelId: string, config: TelegramInstanceConfig): ChannelProvider {
    return new TelegramProvider(channelId, config.botToken, config.chatId);
  },

  displayName(instanceId: string): string {
    return `Telegram (${instanceId})`;
  },
};
