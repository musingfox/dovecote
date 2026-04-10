import type { Env, ChannelConfig, SendResult } from "../types.js";

export interface ChannelProvider {
  send(message: string): Promise<SendResult>;
}

export interface ChannelFactory {
  id: string;
  create(env: Env): ChannelProvider | null;
  getConfig(env: Env): ChannelConfig;
}
