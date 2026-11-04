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
import { issueToken, TOKEN_PREFIX, verifyToken } from "./auth/api-token.js";
import { checkRateLimit } from "./auth/rate-limit.js";
import { refuseRefreshOfUnboundGrant } from "./auth/refresh-binding.js";
import { guardAuthorizeClientId, guardTokenClientId } from "./auth/cimd.js";

// The resource is the URL MCP clients connect to, and 1.x binds every token to
// it. It is derived per origin so one build serves both Workers: production
// on dovecote.musingfox.me (its workers.dev route is disabled in wrangler.toml)
// and staging, a separate Worker (dovecote-staging) on its workers.dev URL.
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
    tokenExchangeCallback: refuseRefreshOfUnboundGrant,
    // URL client_ids resolve through their metadata document, limited to
    // src/auth/cimd.ts's allowlist by the guards below.
    clientIdMetadataDocumentEnabled: true,
    // Headless MCP clients send the dvct token itself. Its props match the
    // ones /authorize binds into a grant, so src/api.ts re-checks it the same
    // way. The provider requires an audience; a dvct token is valid for this
    // resource by policy.
    resolveExternalToken: async ({ token, env }) => {
      if (!token.startsWith(TOKEN_PREFIX)) return null;
      const outcome = await verifyToken(token, env);
      if (outcome.kind !== "valid") return null;
      const { userId, scopes, tokenId } = outcome.auth;
      return {
        props: { userId, scopes, authMethod: "api_token", tokenId },
        audience: `${origin}/mcp`,
      };
    },
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

// Same loopback set as the provider's isLoopbackHostname.
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const ipv4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  return ipv4 !== null && ipv4.slice(1).every((octet) => Number(octet) <= 255);
}

const app = new Hono<{ Bindings: Env }>();

const oauthPaths = [
  "/mcp",
  "/authorize",
  "/token",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource/mcp",
  "/admin/revoke",
  "/admin/bootstrap-client",
];

// The provider throws when built for an http origin that is not loopback (a
// 500 on OAuth paths, a misleading 401 on /v1/auth/exchange), so such
// requests are turned away before oauthProviderFor or getOAuthApi runs.
// Other methods get a 400 rather than a redirect: their body (a client
// secret, a pasted dvct token, a bearer) has already crossed in cleartext.
for (const path of [...oauthPaths, "/v1/auth/exchange"]) {
  app.use(path, async (c, next) => {
    const url = new URL(c.req.url);
    if (url.protocol !== "http:" || isLoopbackHostname(url.hostname)) return next();
    if (c.req.method === "GET" || c.req.method === "HEAD") {
      url.protocol = "https:";
      return c.redirect(url.toString(), 308);
    }
    return c.json({ error: "invalid_request", error_description: "HTTPS is required" }, 400);
  });
}

// Before the provider, which would fetch any URL client_id it is handed.
app.use("/authorize", guardAuthorizeClientId);
app.use("/token", guardTokenClientId);

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

for (const path of oauthPaths) {
  app.all(path, (c) =>
    oauthProviderFor(new URL(c.req.url).origin).fetch(c.req.raw, c.env, c.executionCtx),
  );
}

export default app;
