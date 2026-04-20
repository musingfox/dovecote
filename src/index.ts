import OAuthProvider from "@cloudflare/workers-oauth-provider";
import apiApp from "./api.js";
import authorizeApp from "./auth/authorize.js";
import { resolveExternalToken } from "./auth/resolve-external-token.js";
import type { Env } from "./types.js";

/**
 * Main OAuth Provider configuration
 * Wraps the MCP API with OAuth 2.1 + PKCE + DCR support
 * while maintaining backward compatibility with legacy bearer tokens via resolveExternalToken
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
  scopesSupported: ["dovecote:notify"],

  // Security: disallow plain PKCE (OAuth 2.1 compliance)
  allowPlainPKCE: false,

  // Legacy bearer token support via external token resolution
  resolveExternalToken,
});
