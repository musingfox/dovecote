import { Hono } from "hono";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import apiApp from "./api.js";
import authorizeApp from "./auth/authorize.js";
import { SCOPES_SUPPORTED } from "./auth/scopes.js";
import { bearerMiddleware } from "./auth/bearer.js";
import { getHealthResponse } from "./version.js";
import type { Env } from "./types.js";

const oauthProvider = new OAuthProvider<Env>({
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
});

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json(getHealthResponse()));

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
