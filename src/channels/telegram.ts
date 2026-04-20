import type { SendResult } from "../types.js";
import type { ChannelProvider, MessageContent, ServiceAdapter, TelegramInstanceConfig } from "./types.js";
import { isValidInstanceId } from "./utils.js";

export class TelegramProvider implements ChannelProvider {
  constructor(
    private channelId: string,
    private botToken: string,
    private chatId: string
  ) {}

  async send(content: MessageContent): Promise<SendResult> {
    if (content.text === undefined) {
      return {
        success: false,
        channel: this.channelId,
        error: "Telegram requires text content",
      };
    }

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: content.text,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        return {
          success: false,
          channel: this.channelId,
          error: `HTTP ${response.status}: ${text}`,
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
    } catch (error) {
      return {
        success: false,
        channel: this.channelId,
        error: error instanceof Error ? error.message : String(error),
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
