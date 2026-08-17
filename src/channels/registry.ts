/**
 * KV-backed channel registry.
 *
 * A channel lives under exactly one key, `channel:<service>-<instanceId>`
 * (see `channelKey`). The key is authoritative for the channel's identity;
 * the record's own `service` / `id` fields are a cross-check and a record
 * that contradicts its key is treated as corrupt (D-M3).
 *
 * Notify resolves one channel with one `KV.get`; listing pays one `KV.list`
 * plus one `get` per record so a corrupt record is skipped rather than
 * advertised as a working channel (D-M2). No caching.
 */

import type { Env, ChannelConfig, SendResult } from "../types.js";
import type {
  MessageContent,
  ServiceAdapter,
  TelegramInstanceConfig,
  DiscordInstanceConfig,
} from "./types.js";
import { telegramAdapter } from "./telegram.js";
import { discordAdapter } from "./discord.js";
import { splitChannelId, channelKey, CHANNEL_KEY_PREFIX } from "./utils.js";

const adapters: ServiceAdapter[] = [
  telegramAdapter as ServiceAdapter,
  discordAdapter as ServiceAdapter,
];

const adapterMap = new Map<string, ServiceAdapter>(adapters.map((a) => [a.service, a]));

/**
 * Conservative charset guard applied before any KV read, mirroring
 * `readUserRecord` — an attacker-supplied channel id must never be able to
 * probe arbitrary KV entries.
 */
const CHANNEL_ID_REGEX = /^[a-z0-9][a-z0-9-]{0,79}$/;

export interface ChannelRecord {
  service: string;
  config: TelegramInstanceConfig | DiscordInstanceConfig;
}

/**
 * Read and validate one stored channel record. Returns `null` for a malformed
 * id (no KV read is issued), an unknown service, a KV miss, unparseable JSON,
 * a rejected record, or a record that disagrees with its own key.
 */
export async function readChannelRecord(
  channelId: string,
  env: Env
): Promise<ChannelRecord | null> {
  if (typeof channelId !== "string" || !CHANNEL_ID_REGEX.test(channelId)) {
    return null;
  }

  const split = splitChannelId(channelId);
  if (!split) {
    return null;
  }

  const adapter = adapterMap.get(split.service);
  if (!adapter) {
    return null;
  }

  const key = channelKey(split.service, split.instance);
  const raw = await env.OAUTH_KV.get(key);
  if (raw === null || raw === undefined) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`${key}: invalid JSON`);
    return null;
  }

  const result = adapter.parseRecord(parsed);
  if (!result.ok) {
    console.warn(`${key}: ${result.error}`);
    return null;
  }

  const config = result.config as TelegramInstanceConfig | DiscordInstanceConfig;
  if (config.id !== split.instance) {
    console.warn(`${key}: record id '${config.id}' does not match its key`);
    return null;
  }

  return { service: split.service, config };
}

/**
 * Every channel whose stored record is valid, ascending by channel id.
 * Corrupt records are omitted (and warned about) so one bad channel cannot
 * hide the others. A KV `list` failure propagates — an unavailable KV is not
 * the same as "no channels".
 */
export async function getChannelConfigs(env: Env): Promise<ChannelConfig[]> {
  const listing = await env.OAUTH_KV.list({ prefix: CHANNEL_KEY_PREFIX });

  const configs: ChannelConfig[] = [];

  for (const entry of listing.keys) {
    const channelId = entry.name.slice(CHANNEL_KEY_PREFIX.length);
    const record = await readChannelRecord(channelId, env);
    if (!record) {
      continue;
    }

    const adapter = adapterMap.get(record.service);
    configs.push({
      id: channelId,
      name: adapter ? adapter.displayName(record.config.id) : channelId,
      enabled: true,
      service: record.service,
    });
  }

  configs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return configs;
}

export async function sendToChannel(
  channelId: string,
  content: MessageContent,
  env: Env
): Promise<SendResult> {
  const record = await readChannelRecord(channelId, env);

  if (!record) {
    return {
      success: false,
      channel: channelId,
      error: "Unknown channel",
    };
  }

  const adapter = adapterMap.get(record.service);
  if (!adapter) {
    return {
      success: false,
      channel: channelId,
      error: "Unknown channel",
    };
  }

  return adapter.createProvider(channelId, record.config).send(content);
}
