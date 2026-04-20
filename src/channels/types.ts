import type { Env, ChannelConfig, SendResult } from "../types.js";

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  timestamp?: string;
  color?: number;
  footer?: {
    text: string;
    icon_url?: string;
  };
  image?: {
    url: string;
  };
  thumbnail?: {
    url: string;
  };
  author?: {
    name: string;
    url?: string;
    icon_url?: string;
  };
  fields?: Array<{
    name: string;
    value: string;
    inline?: boolean;
  }>;
}

export interface MessageContent {
  text?: string;
  embed?: DiscordEmbed;
}

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
