import type { KVNamespace } from "@cloudflare/workers-types";

export interface Env {
  MCP_AUTH_TOKEN: string;
  TELEGRAM_INSTANCES?: string;
  DISCORD_INSTANCES?: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PASSWORD: string;
  COOKIE_ENCRYPTION_KEY: string;
  ADMIN_REVOKE_TOKEN?: string;
}

export interface ChannelConfig {
  id: string;
  name: string;
  enabled: boolean;
  service: string;
}

export interface SendResult {
  success: boolean;
  channel: string;
  messageId?: string;
  detail?: {
    text?: string;
    chatId?: string;
  };
  error?: string;
}
