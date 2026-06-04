import { Hono } from "hono";
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { Env } from "../types.js";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { generateCSRF, validateCSRF } from "./csrf.js";
import { SCOPES_SUPPORTED, SCOPE_DESCRIPTIONS } from "./scopes.js";
import { writeAudit } from "./audit.js";
import { checkRateLimit } from "./rate-limit.js";
import { validateRevokeBody } from "./revoke-schema.js";
import { validateBootstrapBody } from "./bootstrap-schema.js";
import { resolveUserId } from "./resolve-user.js";
import { decodeOidcState } from "./oidc-rp-state.js";
import { parseOidcIssuers, getOidcClockToleranceSec } from "./oidc-config.js";
import { verifyOidcIdToken } from "./oidc-verify.js";
import * as jose from "jose";

// Extend Env to include the OAUTH_PROVIDER helper
interface AuthEnv extends Env {
  OAUTH_PROVIDER: OAuthHelpers;
}

const securityHeaders = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
} as const;

/** Module-level JWKS cache for the callback handler (keyed by jwks_uri). */
const callbackJwksCache = new Map<string, jose.JWTVerifyGetKey>();

const app = new Hono<{ Bindings: AuthEnv }>();

/**
 * Timing-safe string comparison (length-independent)
 */
function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * GET /authorize - Display authorization form
 */
app.get("/authorize", async (c) => {
  try {
    const authRequest = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);

    // Validate scopes
    const hasInvalidScope = authRequest.scope.some(
      (s) => !(SCOPES_SUPPORTED as readonly string[]).includes(s)
    );
    if (hasInvalidScope) {
      return c.text("Bad Request: Invalid scope requested", 400, securityHeaders);
    }

    // Generate CSRF token
    const { token: csrfToken, cookie } = await generateCSRF({
      secretKey: c.env.COOKIE_ENCRYPTION_KEY,
    });

    // Render HTML form
    const html = renderAuthorizationForm(authRequest, csrfToken);

    return c.html(html, 200, {
      ...securityHeaders,
      "Set-Cookie": cookie,
    });
  } catch (error) {
    return c.text("Bad Request: Invalid authorization request", 400, securityHeaders);
  }
});

/**
 * POST /authorize - Process authorization form submission
 */
app.post("/authorize", async (c) => {
  // Validate CSRF
  const isValidCSRF = await validateCSRF({
    request: c.req.raw,
    secretKey: c.env.COOKIE_ENCRYPTION_KEY,
  });

  if (!isValidCSRF) {
    return c.text("Forbidden: Invalid CSRF token", 403);
  }

  const formData = await c.req.formData();
  const username = formData.get("username");
  const password = formData.get("password");

  if (typeof username !== "string" || username.length === 0) {
    return c.text("Forbidden: Invalid credentials", 403);
  }
  if (typeof password !== "string") {
    return c.text("Forbidden: Invalid credentials", 403);
  }

  const requestedScopes: string[] = (formData.get("scope") as string)?.split(" ") || [];

  // Resolve user via the seam (Contract H → Contract A)
  const authed = await resolveUserId(
    { kind: "form", username, password },
    c.env,
  );
  if (!authed) {
    return c.text("Forbidden: Invalid credentials", 403);
  }

  // Filter requested scopes to only supported ones AND only those granted to the user
  const userScopeSet = new Set(authed.scopes);
  const effectiveScopes = requestedScopes
    .filter((s) => (SCOPES_SUPPORTED as readonly string[]).includes(s))
    .filter((s) => userScopeSet.has(s));

  // If the user requested any scope they don't have → reject
  const requestedSupported = requestedScopes.filter((s) =>
    (SCOPES_SUPPORTED as readonly string[]).includes(s),
  );
  const missingScopes = requestedSupported.filter((s) => !userScopeSet.has(s));
  if (missingScopes.length > 0) {
    return c.text("Forbidden: Insufficient scope", 403);
  }

  const authRequest: AuthRequest = {
    responseType: formData.get("response_type") as string,
    clientId: formData.get("client_id") as string,
    redirectUri: formData.get("redirect_uri") as string,
    state: formData.get("state") as string,
    scope: requestedScopes,
    codeChallenge: (formData.get("code_challenge") as string) || undefined,
    codeChallengeMethod: (formData.get("code_challenge_method") as string) || undefined,
  };

  // Handle optional resource parameter
  const resourceParam = formData.get("resource");
  if (resourceParam) {
    authRequest.resource = resourceParam as string;
  }

  try {
    // Complete authorization
    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: authRequest,
      userId: authed.userId,
      scope: effectiveScopes,
      metadata: { label: authed.userId },
      props: {
        userId: authed.userId,
        scopes: effectiveScopes,
        authMethod: "oauth",
        ip: c.req.raw.headers.get("CF-Connecting-IP") ?? "unknown",
      },
    });

    // Emit audit event on success
    // Shim for c.executionCtx if not available (e.g., in Hono subrouters or tests)
    let ctx: ExecutionContext;
    try {
      ctx = c.executionCtx;
    } catch {
      // ExecutionContext not available (e.g., in tests)
      ctx = {
        waitUntil: (p: Promise<any>) => {
          p.catch(() => {});
        },
        passThroughOnException: () => {},
      } as any;
    }

    writeAudit(c.env, ctx, {
      event: "authorize",
      userId: authed.userId,
      ok: true,
      authMethod: "none",
      ip: c.req.raw.headers.get("CF-Connecting-IP") ?? "unknown",
      scope: effectiveScopes.join(" "),
    });

    // Redirect to callback URL
    return c.redirect(redirectTo, 302);
  } catch (error) {
    return c.text("Bad Request: Failed to complete authorization", 400);
  }
});

/**
 * Health check endpoint
 */
app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

/**
 * POST /admin/revoke - Revoke an OAuth grant (Contract C)
 * Operator-only endpoint to immediately revoke grants (T1/T11/T17)
 */
app.post("/admin/revoke", async (c) => {
  // C.1: Check if revoke endpoint is configured
  if (!c.env.ADMIN_REVOKE_TOKEN) {
    return c.json({ error: "revoke endpoint not configured" }, 503);
  }

  // Get IP address
  const ip = c.req.raw.headers.get("CF-Connecting-IP") || "unknown";

  // C.2: Rate limiting
  const rateLimitResult = await checkRateLimit(c.env.OAUTH_KV, ip);
  if (!rateLimitResult.allowed) {
    // Shim ExecutionContext for audit
    let ctx: ExecutionContext;
    try {
      ctx = c.executionCtx;
    } catch {
      ctx = {
        waitUntil: (p: Promise<any>) => {
          p.catch(() => {});
        },
        passThroughOnException: () => {},
      } as any;
    }

    writeAudit(c.env, ctx, {
      event: "admin.revoke",
      grantId: "",
      ok: false,
      reason: "rate_limited",
      authMethod: "admin_token",
      ip,
      scope: "dovecote:admin",
    });

    return c.json({ error: "rate limited" }, 429, {
      "Retry-After": "60",
    });
  }

  // C.3: Authorization check
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    // Shim ExecutionContext for audit
    let ctx: ExecutionContext;
    try {
      ctx = c.executionCtx;
    } catch {
      ctx = {
        waitUntil: (p: Promise<any>) => {
          p.catch(() => {});
        },
        passThroughOnException: () => {},
      } as any;
    }

    writeAudit(c.env, ctx, {
      event: "admin.revoke",
      grantId: "",
      ok: false,
      reason: "auth_failed",
      authMethod: "admin_token",
      ip,
      scope: "dovecote:admin",
    });

    return c.json({ error: "unauthorized" }, 401);
  }

  const token = authHeader.substring(7); // Remove "Bearer "
  if (!timingSafeEqual(token, c.env.ADMIN_REVOKE_TOKEN)) {
    // Shim ExecutionContext for audit
    let ctx: ExecutionContext;
    try {
      ctx = c.executionCtx;
    } catch {
      ctx = {
        waitUntil: (p: Promise<any>) => {
          p.catch(() => {});
        },
        passThroughOnException: () => {},
      } as any;
    }

    writeAudit(c.env, ctx, {
      event: "admin.revoke",
      grantId: "",
      ok: false,
      reason: "auth_failed",
      authMethod: "admin_token",
      ip,
      scope: "dovecote:admin",
    });

    return c.json({ error: "unauthorized" }, 401);
  }

  // C.4: Parse and validate request body
  let body: unknown;
  try {
    body = await c.req.json();
  } catch (error) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateRevokeBody(body);
  if (!validation.success) {
    return c.json({ error: validation.error }, 400);
  }

  const { grantId, userId } = validation.data!;

  // Shim ExecutionContext for revokeGrant and audit
  let ctx: ExecutionContext;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = {
      waitUntil: (p: Promise<any>) => {
        p.catch(() => {});
      },
      passThroughOnException: () => {},
    } as any;
  }

  // C.5: Revoke grant via provider (now per-user)
  try {
    await c.env.OAUTH_PROVIDER.revokeGrant(grantId, userId);
  } catch (error) {
    writeAudit(c.env, ctx, {
      event: "admin.revoke",
      grantId,
      ok: false,
      reason: "provider_error",
      authMethod: "admin_token",
      ip,
      scope: "dovecote:admin",
    });

    return c.json({ error: "revoke failed" }, 500);
  }

  // C.6: Success - audit and return
  writeAudit(c.env, ctx, {
    event: "admin.revoke",
    grantId,
    ok: true,
    authMethod: "admin_token",
    ip,
    scope: "dovecote:admin",
  });

  return c.json({ ok: true, grantId }, 200);
});

/**
 * POST /admin/bootstrap-client - Bootstrap OAuth client (Contract Bootstrap-Endpoint)
 * Flag-gated endpoint for operators to create OAuth clients
 */
app.post("/admin/bootstrap-client", async (c) => {
  // Flag check: must be exactly "1" to enable
  if (c.env.ENABLE_CLIENT_BOOTSTRAP !== "1") {
    return c.text("Not Found", 404);
  }

  // Get IP address
  const ip = c.req.raw.headers.get("CF-Connecting-IP") || "unknown";

  // Rate limiting (separate namespace from revoke)
  const rateLimitResult = await checkRateLimit(c.env.OAUTH_KV, ip, "bootstrap");
  if (!rateLimitResult.allowed) {
    // Shim ExecutionContext for audit
    let ctx: ExecutionContext;
    try {
      ctx = c.executionCtx;
    } catch {
      ctx = {
        waitUntil: (p: Promise<any>) => {
          p.catch(() => {});
        },
        passThroughOnException: () => {},
      } as any;
    }

    writeAudit(c.env, ctx, {
      event: "admin.bootstrap",
      clientName: "",
      ok: false,
      reason: "rate_limited",
      authMethod: "admin_token",
      ip,
      scope: "dovecote:admin",
    });

    return c.json({ error: "rate limited" }, 429, {
      "Retry-After": "60",
    });
  }

  // Authorization check
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    // Shim ExecutionContext for audit
    let ctx: ExecutionContext;
    try {
      ctx = c.executionCtx;
    } catch {
      ctx = {
        waitUntil: (p: Promise<any>) => {
          p.catch(() => {});
        },
        passThroughOnException: () => {},
      } as any;
    }

    writeAudit(c.env, ctx, {
      event: "admin.bootstrap",
      clientName: "",
      ok: false,
      reason: "auth_failed",
      authMethod: "admin_token",
      ip,
      scope: "dovecote:admin",
    });

    return c.json({ error: "unauthorized" }, 401);
  }

  const token = authHeader.substring(7); // Remove "Bearer "
  if (!c.env.ADMIN_REVOKE_TOKEN || !timingSafeEqual(token, c.env.ADMIN_REVOKE_TOKEN)) {
    // Shim ExecutionContext for audit
    let ctx: ExecutionContext;
    try {
      ctx = c.executionCtx;
    } catch {
      ctx = {
        waitUntil: (p: Promise<any>) => {
          p.catch(() => {});
        },
        passThroughOnException: () => {},
      } as any;
    }

    writeAudit(c.env, ctx, {
      event: "admin.bootstrap",
      clientName: "",
      ok: false,
      reason: "auth_failed",
      authMethod: "admin_token",
      ip,
      scope: "dovecote:admin",
    });

    return c.json({ error: "unauthorized" }, 401);
  }

  // Parse and validate request body
  let body: unknown;
  try {
    body = await c.req.json();
  } catch (error) {
    // Shim ExecutionContext for audit
    let ctx: ExecutionContext;
    try {
      ctx = c.executionCtx;
    } catch {
      ctx = {
        waitUntil: (p: Promise<any>) => {
          p.catch(() => {});
        },
        passThroughOnException: () => {},
      } as any;
    }

    writeAudit(c.env, ctx, {
      event: "admin.bootstrap",
      clientName: "",
      ok: false,
      reason: "invalid_json",
      authMethod: "admin_token",
      ip,
      scope: "dovecote:admin",
    });

    return c.json({ error: "Invalid JSON" }, 400);
  }

  const validation = validateBootstrapBody(body);
  if (!validation.success) {
    // Shim ExecutionContext for audit
    let ctx: ExecutionContext;
    try {
      ctx = c.executionCtx;
    } catch {
      ctx = {
        waitUntil: (p: Promise<any>) => {
          p.catch(() => {});
        },
        passThroughOnException: () => {},
      } as any;
    }

    writeAudit(c.env, ctx, {
      event: "admin.bootstrap",
      clientName: "",
      ok: false,
      reason: "invalid_body",
      authMethod: "admin_token",
      ip,
      scope: "dovecote:admin",
    });

    return c.json({ error: validation.error }, 400);
  }

  const { clientName, redirectUris } = validation.data!;

  // Shim ExecutionContext for createClient and audit
  let ctx: ExecutionContext;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = {
      waitUntil: (p: Promise<any>) => {
        p.catch(() => {});
      },
      passThroughOnException: () => {},
    } as any;
  }

  // Create client via provider (public client with no secret)
  try {
    const result = await c.env.OAUTH_PROVIDER.createClient({
      clientName,
      redirectUris,
      tokenEndpointAuthMethod: "none",
    });

    // Success - audit and return
    writeAudit(c.env, ctx, {
      event: "admin.bootstrap",
      clientName,
      ok: true,
      authMethod: "admin_token",
      ip,
      scope: "dovecote:admin",
    });

    return c.json({ client_id: result.clientId }, 200);
  } catch (error) {
    writeAudit(c.env, ctx, {
      event: "admin.bootstrap",
      clientName,
      ok: false,
      reason: "provider_error",
      authMethod: "admin_token",
      ip,
      scope: "dovecote:admin",
    });

    return c.json({ error: "bootstrap failed" }, 500);
  }
});

/**
 * GET /oidc/callback — full OIDC RP flow (turn-12).
 *
 * Guard order (each reject path never calls completeAuthorization):
 *   1. no OAUTH_PROVIDER → 500 no_provider
 *   2. OIDC_STATE_SECRET missing/short → 500 config_error
 *   3. missing code or state → 400 missing_params
 *   4. decodeOidcState null → 400 invalid_state
 *   5. state.iat expired (>600 s) → 400 state_expired
 *   6. upstream token exchange fail/no id_token → 502 upstream_exchange_failed
 *   7. verifyOidcIdToken → untrusted_issuer/bad_signature/expired_token
 *   8. nonce mismatch → 400 nonce_mismatch
 *   9. resolveUserId throw/null → 500 user_resolve_failed
 *  10. completeAuthorization → 302
 */
app.get("/oidc/callback", async (c) => {
  // Guard 1 — no provider
  if (!c.env.OAUTH_PROVIDER) return c.json({ error: "no_provider" }, 500);

  // Guard 2 — state secret config (fail-closed)
  const stateSecret = c.env.OIDC_STATE_SECRET;
  if (!stateSecret || stateSecret.length < 32) {
    return c.json({ error: "config_error" }, 500);
  }

  // Guard 3 — required query params
  const code = c.req.query("code");
  const stateParam = c.req.query("state");
  if (!code || !stateParam) return c.json({ error: "missing_params" }, 400);

  // Guard 4 — decode & verify state signature
  const payload = await decodeOidcState(stateParam, stateSecret);
  if (payload === null) return c.json({ error: "invalid_state" }, 400);

  // Guard 5 — state TTL (10 minutes)
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.iat === "number" && nowSec - payload.iat > 600) {
    return c.json({ error: "state_expired" }, 400);
  }

  // Load issuer allow-list. Use first issuer as the target for the callback.
  // (Multi-issuer: the state should carry the issuer; as a two-way-door default
  //  we derive from the allow-list matching — if only one issuer, that's it.)
  let allowList: ReturnType<typeof parseOidcIssuers>;
  try {
    allowList = parseOidcIssuers(c.env);
  } catch {
    return c.json({ error: "config_error" }, 500);
  }
  // Derive issuer config: pick first (fixture always has one). If the state
  // carried an issuer field we could match; for now pick first as default.
  const issuerConfig = allowList[0];
  if (!issuerConfig) return c.json({ error: "config_error" }, 500);

  // Guard 6 — upstream code→token exchange
  const tokenEndpoint = issuerConfig.token_endpoint ?? `${issuerConfig.issuer}/token`;
  const formParams = new URLSearchParams({ grant_type: "authorization_code", code });
  if (payload.redirectUri) formParams.set("redirect_uri", payload.redirectUri);
  if (issuerConfig.client_id ?? payload.clientId) {
    formParams.set("client_id", issuerConfig.client_id ?? payload.clientId);
  }
  if (issuerConfig.client_secret) {
    formParams.set("client_secret", issuerConfig.client_secret);
  }

  let idToken: string;
  try {
    const tokenRes = await globalThis.fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formParams.toString(),
    });
    if (!tokenRes.ok) {
      return c.json({ error: "upstream_exchange_failed" }, 502);
    }
    const tokenBody = (await tokenRes.json()) as Record<string, unknown>;
    if (typeof tokenBody.id_token !== "string" || !tokenBody.id_token) {
      return c.json({ error: "upstream_exchange_failed" }, 502);
    }
    idToken = tokenBody.id_token;
  } catch {
    return c.json({ error: "upstream_exchange_failed" }, 502);
  }

  // Guard 7 — verify id_token (uses createRemoteJWKSet → globalThis.fetch)
  const clockToleranceSec = getOidcClockToleranceSec(c.env);

  // JWKS cache keyed by jwks_uri (module-level, same pattern as exchange-oidc)
  const jwksKey = issuerConfig.jwks_uri;
  if (!callbackJwksCache.has(jwksKey)) {
    callbackJwksCache.set(
      jwksKey,
      jose.createRemoteJWKSet(new URL(jwksKey)),
    );
  }
  const getKey = callbackJwksCache.get(jwksKey)!;

  const verifyOutcome = await verifyOidcIdToken({
    idToken,
    allowList,
    clockToleranceSec,
    jwksResolver: () => getKey,
  });

  if (verifyOutcome.kind !== "ok") {
    switch (verifyOutcome.kind) {
      case "untrusted_issuer":
        return c.json({ error: "untrusted_issuer" }, 400);
      case "expired_token":
        return c.json({ error: "expired_token" }, 400);
      default:
        return c.json({ error: "bad_signature" }, 400);
    }
  }

  // Guard 8 — nonce binding (prevents replay)
  const claims = verifyOutcome.claims;
  if (claims.nonce !== payload.nonce) {
    return c.json({ error: "nonce_mismatch" }, 400);
  }

  // Guard 9 — resolve/provision user
  let resolved: { userId: string; scopes: string[] } | null;
  try {
    resolved = await resolveUserId(
      { kind: "oidc", issuer: verifyOutcome.issuer, subject: verifyOutcome.subClaim },
      c.env,
    );
  } catch {
    return c.json({ error: "user_resolve_failed" }, 500);
  }
  if (!resolved) return c.json({ error: "user_resolve_failed" }, 500);

  // Guard 10 — complete OAuth authorization → 302
  const authRequest: AuthRequest = {
    responseType: payload.responseType,
    clientId: payload.clientId,
    redirectUri: payload.redirectUri,
    scope: payload.scope,
    state: payload.state,
    ...(payload.codeChallenge ? { codeChallenge: payload.codeChallenge } : {}),
    ...(payload.codeChallengeMethod ? { codeChallengeMethod: payload.codeChallengeMethod } : {}),
  };

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: authRequest,
    userId: resolved.userId,
    scope: resolved.scopes,
    metadata: {},
    props: {
      userId: resolved.userId,
      scopes: resolved.scopes,
      authMethod: "oidc",
    },
  });

  return Response.redirect(redirectTo, 302);
});

/**
 * Fallback for unknown paths - 404
 */
app.all("*", (c) => {
  return c.text("Not Found", 404);
});

/**
 * Render the authorization form HTML
 */
function renderAuthorizationForm(authRequest: AuthRequest, csrfToken: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorize Access - Dovecote</title>
  <style>
    body {
      font-family: system-ui, -apple-system, sans-serif;
      max-width: 400px;
      margin: 80px auto;
      padding: 20px;
      background: #f5f5f5;
    }
    .form-container {
      background: white;
      padding: 30px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    h1 {
      margin-top: 0;
      font-size: 24px;
      color: #333;
    }
    .info {
      margin: 20px 0;
      padding: 15px;
      background: #f0f0f0;
      border-radius: 4px;
      font-size: 14px;
    }
    .info-label {
      font-weight: bold;
      color: #666;
    }
    .info-value {
      color: #333;
      word-break: break-all;
    }
    .scope-warning {
      color: #d32f2f;
      font-size: 13px;
      margin-top: 6px;
    }
    label {
      display: block;
      margin-top: 20px;
      margin-bottom: 8px;
      font-weight: 500;
      color: #333;
    }
    input[type="text"],
    input[type="password"] {
      width: 100%;
      padding: 10px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 14px;
      box-sizing: border-box;
    }
    button {
      width: 100%;
      margin-top: 20px;
      padding: 12px;
      background: #007bff;
      color: white;
      border: none;
      border-radius: 4px;
      font-size: 16px;
      font-weight: 500;
      cursor: pointer;
    }
    button:hover {
      background: #0056b3;
    }
  </style>
</head>
<body>
  <div class="form-container">
    <h1>Authorize Access</h1>
    <div class="info">
      <div class="info-label">Client:</div>
      <div class="info-value">${escapeHtml(authRequest.clientId)}</div>
    </div>
    ${
      authRequest.scope && authRequest.scope.length > 0
        ? authRequest.scope.map((scopeName) => {
            const scopeInfo = SCOPE_DESCRIPTIONS[scopeName as keyof typeof SCOPE_DESCRIPTIONS];
            const description = scopeInfo.description;
            const warning = scopeInfo.warning;
            return `<div class="info">
      <div class="info-label">${escapeHtml(scopeName)}</div>
      <div class="info-value">${escapeHtml(description)}</div>
      ${warning ? `<div class="scope-warning">${escapeHtml(warning)}</div>` : ""}
    </div>`;
          }).join("")
        : ""
    }
    <form method="POST" action="/authorize">
      <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
      <input type="hidden" name="response_type" value="${escapeHtml(authRequest.responseType)}">
      <input type="hidden" name="client_id" value="${escapeHtml(authRequest.clientId)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(authRequest.redirectUri)}">
      <input type="hidden" name="state" value="${escapeHtml(authRequest.state)}">
      <input type="hidden" name="scope" value="${escapeHtml(authRequest.scope?.join(" ") || "")}">
      ${authRequest.codeChallenge ? `<input type="hidden" name="code_challenge" value="${escapeHtml(authRequest.codeChallenge)}">` : ""}
      ${authRequest.codeChallengeMethod ? `<input type="hidden" name="code_challenge_method" value="${escapeHtml(authRequest.codeChallengeMethod)}">` : ""}
      ${authRequest.resource ? `<input type="hidden" name="resource" value="${escapeHtml(typeof authRequest.resource === "string" ? authRequest.resource : authRequest.resource[0] ?? "")}">` : ""}

      <label for="username">Username:</label>
      <input type="text" id="username" name="username" required autofocus autocomplete="username">

      <label for="password">Password:</label>
      <input type="password" id="password" name="password" required autocomplete="current-password">

      <button type="submit">Authorize</button>
    </form>
  </div>
</body>
</html>`;
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(str: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return str.replace(/[&<>"']/g, (char) => map[char] ?? char);
}

export default app;
