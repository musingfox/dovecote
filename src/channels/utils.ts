import type {
  DiscordInstanceConfig,
  StoredChannelRecord,
  TelegramInstanceConfig,
} from "./types.js";

export function splitChannelId(composite: string): { service: string; instance: string } | null {
  const firstDashIndex = composite.indexOf("-");
  if (firstDashIndex === -1) {
    return null;
  }

  const service = composite.slice(0, firstDashIndex);
  const instance = composite.slice(firstDashIndex + 1);

  if (service === "" || instance === "") {
    return null;
  }

  return { service, instance };
}

export const INSTANCE_ID_REGEX = /^[a-z0-9][a-z0-9-]*$/;

export function isValidInstanceId(id: string): boolean {
  if (!INSTANCE_ID_REGEX.test(id)) {
    return false;
  }
  // No trailing dash
  if (id.endsWith("-")) {
    return false;
  }
  // No consecutive dashes
  if (id.includes("--")) {
    return false;
  }
  return true;
}

/** KV key prefix under which every channel record is stored. */
export const CHANNEL_KEY_PREFIX = "channel:";

/**
 * The one canonical KV key for a channel: `channel:<service>-<instanceId>`.
 * The key is authoritative for the channel's identity (D-M3); the record body
 * merely repeats `service` / `id` so a raw KV dump is self-explanatory.
 */
export function channelKey(service: string, instanceId: string): string {
  return `${CHANNEL_KEY_PREFIX}${service}-${instanceId}`;
}

/**
 * The one canonical stored body for a channel record. Key order is fixed by
 * the object literal (`service`, `id`, then the service-specific fields) so
 * every writer emits byte-identical JSON and re-running a migration converges.
 */
export function serializeChannelRecord(service: "telegram", config: TelegramInstanceConfig): string;
export function serializeChannelRecord(service: "discord", config: DiscordInstanceConfig): string;
export function serializeChannelRecord(
  service: "telegram" | "discord",
  config: TelegramInstanceConfig | DiscordInstanceConfig
): string {
  if (service === "telegram") {
    const telegram = config as TelegramInstanceConfig;
    const record: StoredChannelRecord = {
      service: "telegram",
      id: telegram.id,
      botToken: telegram.botToken,
      chatId: telegram.chatId,
    };
    return JSON.stringify(record);
  }

  const discord = config as DiscordInstanceConfig;
  const record: StoredChannelRecord = {
    service: "discord",
    id: discord.id,
    webhookUrl: discord.webhookUrl,
  };
  return JSON.stringify(record);
}

const ALLOWED_DISCORD_HOSTNAMES = new Set(["discord.com", "discordapp.com"]);

export function isValidDiscordWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    if (parsed.protocol !== "https:") {
      return false;
    }

    if (!ALLOWED_DISCORD_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
      return false;
    }

    if (parsed.port !== "") {
      return false;
    }

    if (!parsed.pathname.startsWith("/api/webhooks/")) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}
