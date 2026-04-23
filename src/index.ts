import OAuthProvider from "@cloudflare/workers-oauth-provider";
import apiApp from "./api.js";
import authorizeApp from "./auth/authorize.js";
import { SCOPES_SUPPORTED } from "./auth/scopes.js";
import type { Env } from "./types.js";

/**
 * Main OAuth Provider configuration
 * Wraps the MCP API with OAuth 2.1 + PKCE + DCR support
 */
export default new OAuthProvider<Env>({
  // API handler wrapping - the library expects an object with a fetch method
  apiHandler: { fetch: apiApp.fetch.bind(apiApp) },
  apiRoute: "/mcp",

  // Authorization UI handler
  defaultHandler: { fetch: authorizeApp.fetch.bind(authorizeApp) },

  // OAuth endpoints
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",

  // Scopes
  scopesSupported: [...SCOPES_SUPPORTED],

  // Token TTLs
  accessTokenTTL: 3600,
  refreshTokenTTL: 2592000,

  // Security: disallow plain PKCE (OAuth 2.1 compliance)
  allowPlainPKCE: false,

  // DCR closed: disallow public client registration
  disallowPublicClientRegistration: true,
});
