import type { KVNamespace } from "@cloudflare/workers-types";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

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
  NOTIFY_RATE_LIMIT_PER_MINUTE?: string;
  /**
   * JSON array of OIDC issuer configs trusted by POST /v1/auth/exchange-oidc.
   * Each entry: `{issuer, jwks_uri, audience, subClaim?}`. Unset/malformed → 503.
   */
  OIDC_ISSUERS?: string;
  /** Clock-skew tolerance (seconds) for OIDC iat/exp validation. Default 60. */
  OIDC_CLOCK_TOLERANCE_SEC?: string;
  /**
   * CF Access / OAuth provider helper injected by @cloudflare/workers-oauth-provider
   * at runtime. Optional in Env so existing code compiles without it; the callback
   * handler guards against its absence with a 500.
   */
  OAUTH_PROVIDER?: OAuthHelpers;
  /**
   * RP client_id registered at the upstream IdP (CF Access application).
   * Used by the production exchangeUpstreamCode implementation.
   */
  OIDC_RP_CLIENT_ID?: string;
  /**
   * RP client_secret for the upstream IdP token endpoint.
   */
  OIDC_RP_CLIENT_SECRET?: string;
  /**
   * Upstream IdP token endpoint URL.
   * e.g. "https://<team>.cloudflareaccess.com/cdn-cgi/access/token"
   */
  OIDC_RP_TOKEN_ENDPOINT?: string;
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
