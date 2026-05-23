import type { KVNamespace } from "@cloudflare/workers-types";

export interface Env {
  TELEGRAM_INSTANCES?: string;
  DISCORD_INSTANCES?: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PASSWORD: string;
  COOKIE_ENCRYPTION_KEY: string;
  ADMIN_REVOKE_TOKEN?: string;
  HMAC_PEPPER: string;
  ENABLE_CLIENT_BOOTSTRAP?: string;
  LEGACY_OPERATOR_USERNAME?: string;
  /**
   * JSON array of OIDC issuer configs trusted by POST /v1/auth/exchange-oidc.
   * Each entry: `{issuer, jwks_uri, audience, subClaim?}`. Unset/malformed → 503.
   */
  OIDC_ISSUERS?: string;
  /** Clock-skew tolerance (seconds) for OIDC iat/exp validation. Default 60. */
  OIDC_CLOCK_TOLERANCE_SEC?: string;
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
