import type { Env, ChannelConfig, SendResult } from "../types.js";
import type { DiscordEmbed, MessageContent } from "../contracts/notifications.js";
export type { DiscordEmbed, MessageContent } from "../contracts/notifications.js";

export interface ChannelProvider {
  send(content: MessageContent): Promise<SendResult>;
}

export interface ServiceAdapter<C = unknown> {
  service: string;
  envKey: string;
  parseInstances(json: string | undefined): { instances: C[]; errors: string[] };
  createProvider(channelId: string, config: C): ChannelProvider;
  displayName(instanceId: string): string;
}

export interface ChannelRegistration {
  channelId: string;
  service: string;
  createProvider: () => ChannelProvider;
}

export interface TelegramInstanceConfig {
  id: string;
  botToken: string;
  chatId: string;
}

export interface DiscordInstanceConfig {
  id: string;
  webhookUrl: string;
}

/**
 * The JSON body stored under a `channel:<service>-<instanceId>` KV key.
 * `service` / `id` are self-description; the key stays authoritative (D-M3).
 */
export type StoredChannelRecord =
  | ({ service: "telegram" } & TelegramInstanceConfig)
  | ({ service: "discord" } & DiscordInstanceConfig);
