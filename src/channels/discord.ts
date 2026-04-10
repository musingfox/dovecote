import type { Env, SendResult } from "../types.js";
import type { ChannelProvider, ChannelFactory } from "./types.js";

export class DiscordProvider implements ChannelProvider {
  constructor(private webhookUrl: string) {}

  async send(message: string): Promise<SendResult> {
    try {
      const response = await fetch(this.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: message,
          username: "Dovecote",
        }),
      });

      if (response.status === 204) {
        return {
          success: true,
          channel: "discord",
        };
      }

      const text = await response.text();
      return {
        success: false,
        channel: "discord",
        error: `HTTP ${response.status}: ${text}`,
      };
    } catch (error) {
      return {
        success: false,
        channel: "discord",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export const discordFactory: ChannelFactory = {
  id: "discord",
  create(env: Env): ChannelProvider | null {
    if (env.DISCORD_WEBHOOK_URL) {
      return new DiscordProvider(env.DISCORD_WEBHOOK_URL);
    }
    return null;
  },
  getConfig(env: Env) {
    return {
      id: "discord",
      name: "Discord",
      enabled: !!env.DISCORD_WEBHOOK_URL,
    };
  },
};
