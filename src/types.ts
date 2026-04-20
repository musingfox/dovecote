export interface Env {
  MCP_AUTH_TOKEN: string;
  TELEGRAM_INSTANCES?: string;
  DISCORD_INSTANCES?: string;
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
