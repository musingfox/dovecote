import type { Env, ChannelConfig, SendResult } from "../types.js";
import type { DiscordEmbed, MessageContent } from "../contracts/notifications.js";
export type { DiscordEmbed, MessageContent } from "../contracts/notifications.js";

export interface ChannelProvider {
  send(content: MessageContent): Promise<SendResult>;
}

/** Outcome of validating one stored channel record body. */
export type ParseRecordResult<C> = { ok: true; config: C } | { ok: false; error: string };

export interface ServiceAdapter<C = unknown> {
  service: string;
  /**
   * Validate one stored KV record body. Errors are bare messages with no
   * environment-variable name and no KV key — the reader adds the key (D-M6).
   */
  parseRecord(raw: unknown): ParseRecordResult<C>;
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
