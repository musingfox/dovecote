import { Hono } from "hono";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import apiApp from "./api.js";
import authorizeApp from "./auth/authorize.js";
import { SCOPES_SUPPORTED } from "./auth/scopes.js";
import { bearerMiddleware } from "./auth/bearer.js";
import { getHealthResponse } from "./version.js";
import type { Env } from "./types.js";
import {
  createAuthExchangeApp,
  makeDefaultOAuthUnwrapper,
} from "./auth-exchange.js";
import { createAuthExchangeOidcApp } from "./auth-exchange-oidc.js";
import { createAuthExchangeDeviceApp } from "./auth-exchange-device.js";
import { createDeviceVerificationApp } from "./device-verification.js";
import { issueToken } from "./auth/api-token.js";
import { checkRateLimit } from "./auth/rate-limit.js";

const oauthOptions: OAuthProviderOptions<Env> = {
  apiHandler: { fetch: apiApp.fetch.bind(apiApp) },
  apiRoute: "/mcp",
  defaultHandler: { fetch: authorizeApp.fetch.bind(authorizeApp) },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: [...SCOPES_SUPPORTED],
  accessTokenTTL: 3600,
  refreshTokenTTL: 2592000,
  allowPlainPKCE: false,
  disallowPublicClientRegistration: true,
};

const oauthProvider = new OAuthProvider<Env>(oauthOptions);

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json(getHealthResponse()));

// Carve-out: /v1/auth/exchange validates an OAuth bearer (not dvct_*),
// so it must run BEFORE the /v1/* bearer middleware.
const authExchangeApp = createAuthExchangeApp({
  issueToken,
  checkRateLimit,
  unwrapOAuthToken: makeDefaultOAuthUnwrapper(oauthOptions),
});
app.route("/", authExchangeApp);

// Carve-out: /v1/auth/exchange-oidc verifies an OIDC id_token (not dvct_*),
// so it also runs BEFORE the /v1/* bearer middleware (ADR 0001).
const authExchangeOidcApp = createAuthExchangeOidcApp({
  issueToken,
  checkRateLimit,
});
app.route("/", authExchangeOidcApp);

// Carve-out: /v1/auth/device-authorize + /v1/auth/exchange-device authenticate
// by `device_code`, not `dvct_*`, so they too must precede the bearer middleware.
const authExchangeDeviceApp = createAuthExchangeDeviceApp({
  issueToken,
  checkRateLimit,
});
app.route("/", authExchangeDeviceApp);

// Verification page (GET/POST /device) — browser-only carve-out using cookies
// + CSRF, not bearer auth.
const deviceVerificationApp = createDeviceVerificationApp();
app.route("/", deviceVerificationApp);

app.use("/v1/*", bearerMiddleware);

import v1App from "./api-v1.js";
app.route("/v1", v1App);

const oauthPaths = [
  "/mcp",
  "/authorize",
  "/token",
  "/register",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
  "/admin/revoke",
  "/admin/bootstrap-client",
];

for (const path of oauthPaths) {
  app.all(path, (c) => oauthProvider.fetch(c.req.raw, c.env, c.executionCtx));
}

export default app;
