import type { KVNamespace } from "@cloudflare/workers-types";

export interface Env {
  /**
   * Channels are NOT configured here. Each channel is one `channel:<service>-<id>`
   * record inside OAUTH_KV, written by `bun run channel:add`; the worker has no
   * environment-variable configuration surface for them and no fallback.
   */
  OAUTH_KV: KVNamespace;
  ADMIN_REVOKE_TOKEN?: string;
  HMAC_PEPPER: string;
  ENABLE_CLIENT_BOOTSTRAP?: string;
  NOTIFY_RATE_LIMIT_PER_MINUTE?: string;
  /** Clock-skew tolerance (seconds) for OIDC iat/exp validation. Default 60. */
  OIDC_CLOCK_TOLERANCE_SEC?: string;
  /** Expected `aud` claim for GitHub Actions OIDC tokens. Missing → 503. */
  GITHUB_OIDC_EXPECTED_AUD?: string;
  /** Allowed GitHub organisation/owner in `repository_owner` claim. Missing → 503. */
  GITHUB_OIDC_ALLOWED_OWNER?: string;
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
