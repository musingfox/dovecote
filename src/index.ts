import { Hono } from "hono";
import OAuthProvider, { getOAuthApi } from "@cloudflare/workers-oauth-provider";
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
import { createAuthGithubOidcApp } from "./auth-github-oidc.js";
import { issueToken } from "./auth/api-token.js";
import { checkRateLimit } from "./auth/rate-limit.js";

// The resource is the URL MCP clients connect to, and 1.x binds every token to
// it. It is derived per origin because production and staging serve this
// Worker on different hostnames.
function oauthOptionsFor(origin: string): OAuthProviderOptions<Env> {
  return {
    apiHandler: { fetch: apiApp.fetch.bind(apiApp) },
    apiRoute: "/mcp",
    defaultHandler: { fetch: authorizeApp.fetch.bind(authorizeApp) }, // GET/POST /authorize now form-based (dvct token)
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    scopesSupported: [...SCOPES_SUPPORTED],
    // 0.4 published scopesSupported as the protected resource metadata's scopes_supported; 1.x takes it from here.
    requiredScopes: [...SCOPES_SUPPORTED],
    resourceMetadata: { resource: `${origin}/mcp` },
    accessTokenTTL: 3600,
    refreshTokenTTL: 2592000,
  };
}

const oauthProviders = new Map<string, OAuthProvider<Env>>();

function oauthProviderFor(origin: string): OAuthProvider<Env> {
  let provider = oauthProviders.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>(oauthOptionsFor(origin));
    oauthProviders.set(origin, provider);
  }
  return provider;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json(getHealthResponse()));

// Carve-out: /v1/auth/exchange validates an OAuth bearer (not dvct_*),
// so it must run BEFORE the /v1/* bearer middleware.
const authExchangeApp = createAuthExchangeApp({
  issueToken,
  checkRateLimit,
  unwrapOAuthToken: makeDefaultOAuthUnwrapper((env, origin) =>
    getOAuthApi(oauthOptionsFor(origin), env),
  ),
});
app.route("/", authExchangeApp);

// Carve-out: /v1/auth/github-oidc verifies a GitHub Actions OIDC id_token,
// so it too must precede the /v1/* bearer middleware (ADR 0001).
const authGithubOidcApp = createAuthGithubOidcApp({
  issueToken,
  checkRateLimit,
});
app.route("/", authGithubOidcApp);

app.use("/v1/*", bearerMiddleware);

import v1App from "./api-v1.js";
app.route("/v1", v1App);

const oauthPaths = [
  "/mcp",
  "/authorize",
  "/token",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource/mcp",
  "/admin/revoke",
  "/admin/bootstrap-client",
];

for (const path of oauthPaths) {
  app.all(path, (c) =>
    oauthProviderFor(new URL(c.req.url).origin).fetch(c.req.raw, c.env, c.executionCtx),
  );
}

export default app;
