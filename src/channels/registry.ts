import type { Env, ChannelConfig, SendResult } from "../types.js";
import type { ChannelFactory } from "./types.js";
import { telegramFactory } from "./telegram.js";
import { discordFactory } from "./discord.js";

const factories: ChannelFactory[] = [telegramFactory, discordFactory];

export function getChannelConfigs(env: Env): ChannelConfig[] {
  return factories.map((factory) => factory.getConfig(env));
}

export async function sendToChannel(
  channelId: string,
  message: string,
  env: Env
): Promise<SendResult> {
  const factory = factories.find((f) => f.id === channelId);

  if (!factory) {
    return {
      success: false,
      channel: channelId,
      error: "Unknown channel",
    };
  }

  const provider = factory.create(env);
  if (!provider) {
    return {
      success: false,
      channel: channelId,
      error: "Channel not configured",
    };
  }

  return provider.send(message);
}
