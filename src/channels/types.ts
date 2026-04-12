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

export interface ChannelFactory {
  id: string;
  create(env: Env): ChannelProvider | null;
  getConfig(env: Env): ChannelConfig;
}
