import type { Env, ChannelConfig, SendResult } from "../types.js";
import type { MessageContent, ServiceAdapter, ChannelRegistration } from "./types.js";
import { telegramAdapter } from "./telegram.js";
import { discordAdapter } from "./discord.js";
import { splitChannelId } from "./utils.js";

const adapters: ServiceAdapter[] = [telegramAdapter, discordAdapter];

export function buildChannelRegistry(env: Env): ChannelRegistration[] {
  const registrations: ChannelRegistration[] = [];

  for (const adapter of adapters) {
    const jsonString = env[adapter.envKey as keyof Env];
    const { instances, errors } = adapter.parseInstances(jsonString);

    for (const error of errors) {
      console.warn(error);
    }

    for (const instance of instances) {
      const instanceWithId = instance as { id: string };
      const channelId = `${adapter.service}-${instanceWithId.id}`;
      registrations.push({
        channelId,
        service: adapter.service,
        createProvider: () => adapter.createProvider(channelId, instance),
      });
    }
  }

  return registrations;
}

export function getChannelConfigs(env: Env): ChannelConfig[] {
  const registry = buildChannelRegistry(env);
  const adapterMap = new Map(adapters.map((a) => [a.service, a]));

  return registry.map((reg) => {
    const adapter = adapterMap.get(reg.service);
    const split = splitChannelId(reg.channelId);
    const instanceId = split?.instance ?? reg.channelId;

    return {
      id: reg.channelId,
      name: adapter?.displayName(instanceId) ?? reg.channelId,
      enabled: true,
      service: reg.service,
    };
  });
}

export async function sendToChannel(
  channelId: string,
  content: MessageContent,
  env: Env
): Promise<SendResult> {
  const registry = buildChannelRegistry(env);
  const registration = registry.find((r) => r.channelId === channelId);

  if (!registration) {
    return {
      success: false,
      channel: channelId,
      error: "Unknown channel",
    };
  }

  const provider = registration.createProvider();
  return provider.send(content);
}
