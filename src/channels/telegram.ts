import type { Env, SendResult } from "../types.js";
import type { ChannelProvider, ChannelFactory } from "./types.js";

export class TelegramProvider implements ChannelProvider {
  constructor(
    private botToken: string,
    private chatId: string
  ) {}

  async send(message: string): Promise<SendResult> {
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: message,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        return {
          success: false,
          channel: "telegram",
          error: `HTTP ${response.status}: ${text}`,
        };
      }

      const data = (await response.json()) as any;
      if (data.ok && data.result?.message_id) {
        return {
          success: true,
          channel: "telegram",
          messageId: String(data.result.message_id),
        };
      }

      return {
        success: false,
        channel: "telegram",
        error: "Unexpected response format",
      };
    } catch (error) {
      return {
        success: false,
        channel: "telegram",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export const telegramFactory: ChannelFactory = {
  id: "telegram",
  create(env: Env): ChannelProvider | null {
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      return new TelegramProvider(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID);
    }
    return null;
  },
  getConfig(env: Env) {
    return {
      id: "telegram",
      name: "Telegram",
      enabled: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
    };
  },
};
