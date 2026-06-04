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
import { createAdminIssueTokenApp } from "./admin-issue-token.js";
import { createOidcRpCallbackApp } from "./auth/oidc-rp-callback.js";
import { issueToken } from "./auth/api-token.js";
import { checkRateLimit } from "./auth/rate-limit.js";
import {
  verifyOidcIdToken as defaultVerifyOidcIdToken,
} from "./auth/oidc-verify.js";
import { resolveUserId as defaultResolveUserId } from "./auth/resolve-user.js";

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

// Carve-out: /admin/issue-token authenticates via ADMIN_REVOKE_TOKEN (not
// dvct_*), so it precedes the /v1/* bearer middleware AND the OAuth
// carve-out routes below (those handle /admin/bootstrap-client + /admin/revoke
// through the OAuth provider; this endpoint is independent).
const adminIssueTokenApp = createAdminIssueTokenApp({
  issueToken,
  checkRateLimit,
});
app.route("/", adminIssueTokenApp);

// Carve-out: GET /oidc/callback is the OIDC RP callback route. It authenticates
// via the upstream IdP (not dvct_*), so it must precede the /v1/* bearer
// middleware. It calls env.OAUTH_PROVIDER.completeAuthorization internally.
const oidcRpCallbackApp = createOidcRpCallbackApp({
  exchangeUpstreamCode: async ({ code, redirectUri, env }) => {
    const tokenEndpoint = (env as any).OIDC_RP_TOKEN_ENDPOINT;
    const clientId = (env as any).OIDC_RP_CLIENT_ID;
    const clientSecret = (env as any).OIDC_RP_CLIENT_SECRET;
    if (!tokenEndpoint || !clientId) {
      return { error: "RP token endpoint or client_id not configured" };
    }
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    });
    let resp: Response;
    try {
      resp = await fetch(tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
    } catch (e) {
      return { error: `network_error: ${(e as Error).message}` };
    }
    if (!resp.ok) {
      let detail = "";
      try {
        const body = await resp.json() as any;
        detail = body.error ?? resp.statusText;
      } catch {
        detail = resp.statusText;
      }
      return { error: detail };
    }
    let body: any;
    try {
      body = await resp.json();
    } catch {
      return { error: "invalid_json_response" };
    }
    if (!body.id_token) {
      return { error: "missing_id_token" };
    }
    return { id_token: body.id_token as string };
  },
  verifyOidcIdToken: defaultVerifyOidcIdToken,
  resolveUserId: defaultResolveUserId,
});
app.route("/", oidcRpCallbackApp);

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
