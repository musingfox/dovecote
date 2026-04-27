import type { SendResult } from "../types.js";
import type { ChannelProvider, MessageContent, ServiceAdapter, DiscordInstanceConfig } from "./types.js";
import { isValidInstanceId, isValidDiscordWebhookUrl } from "./utils.js";

const MAX_ERROR_DETAIL = 100;

export class DiscordProvider implements ChannelProvider {
  constructor(
    private channelId: string,
    private webhookUrl: string
  ) {}

  async send(content: MessageContent): Promise<SendResult> {
    try {
      const url = new URL(this.webhookUrl);
      url.searchParams.set("wait", "true");

      const payload: Record<string, unknown> = {
        username: "Dovecote",
      };

      if (content.text !== undefined) {
        payload.content = content.text;
      }

      if (content.embed !== undefined) {
        payload.embeds = [content.embed];
      }

      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        redirect: "manual",
      });

      if (response.status >= 300 && response.status < 400) {
        return {
          success: false,
          channel: this.channelId,
          error: `HTTP ${response.status}: unexpected redirect from Discord webhook`,
        };
      }

      if (response.ok) {
        const data = (await response.json()) as any;
        return {
          success: true,
          channel: this.channelId,
          messageId: data.id,
          detail: {
            text: data.content,
            chatId: data.channel_id,
          },
        };
      }

      const text = await response.text();
      let detail = text;
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed === "object" && parsed !== null && typeof parsed.message === "string") {
          detail = parsed.message;
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
    } catch {
      return {
        success: false,
        channel: this.channelId,
        error: "Network error reaching Discord",
      };
    }
  }
}

export const discordAdapter: ServiceAdapter<DiscordInstanceConfig> = {
  service: "discord",
  envKey: "DISCORD_INSTANCES",

  parseInstances(json: string | undefined): { instances: DiscordInstanceConfig[]; errors: string[] } {
    if (json === undefined || json === "") {
      return { instances: [], errors: [] };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { instances: [], errors: ["DISCORD_INSTANCES: invalid JSON"] };
    }

    if (!Array.isArray(parsed)) {
      return { instances: [], errors: ["DISCORD_INSTANCES: expected array"] };
    }

    const instances: DiscordInstanceConfig[] = [];
    const errors: string[] = [];
    const seenIds = new Set<string>();

    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) {
        errors.push("DISCORD_INSTANCES: entry must be object");
        continue;
      }

      const { id, webhookUrl } = entry as Record<string, unknown>;

      if (typeof id !== "string") {
        errors.push("DISCORD_INSTANCES: missing or invalid 'id'");
        continue;
      }

      const normalizedId = id.toLowerCase();

      if (!isValidInstanceId(normalizedId)) {
        errors.push(`DISCORD_INSTANCES: invalid id '${id}'`);
        continue;
      }

      if (typeof webhookUrl !== "string") {
        errors.push(`DISCORD_INSTANCES: missing 'webhookUrl' for id '${id}'`);
        continue;
      }

      if (!isValidDiscordWebhookUrl(webhookUrl)) {
        errors.push(`DISCORD_INSTANCES: invalid webhookUrl for id '${id}'`);
        continue;
      }

      if (seenIds.has(normalizedId)) {
        return { instances: [], errors: [`DISCORD_INSTANCES: duplicate id '${id}'`] };
      }

      seenIds.add(normalizedId);
      instances.push({ id: normalizedId, webhookUrl });
    }

    return { instances, errors };
  },

  createProvider(channelId: string, config: DiscordInstanceConfig): ChannelProvider {
    return new DiscordProvider(channelId, config.webhookUrl);
  },

  displayName(instanceId: string): string {
    return `Discord (${instanceId})`;
  },
};
