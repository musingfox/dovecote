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

// Extend Env to include the OAUTH_PROVIDER helper
interface AuthEnv extends Env {
  OAUTH_PROVIDER: OAuthHelpers;
}

const securityHeaders = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
} as const;

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

  // Parse form data
  const formData = await c.req.formData();
  const password = formData.get("password");

  // Validate password (timing-safe)
  if (typeof password !== "string" || !timingSafeEqual(password, c.env.OAUTH_PASSWORD)) {
    return c.text("Forbidden: Invalid password", 403);
  }

  // Reconstruct AuthRequest from form fields
  const authRequest: AuthRequest = {
    responseType: formData.get("response_type") as string,
    clientId: formData.get("client_id") as string,
    redirectUri: formData.get("redirect_uri") as string,
    state: formData.get("state") as string,
    scope: (formData.get("scope") as string)?.split(" ") || [],
    codeChallenge: (formData.get("code_challenge") as string) || undefined,
    codeChallengeMethod: (formData.get("code_challenge_method") as string) || undefined,
  };

  // Handle optional resource parameter
  const resourceParam = formData.get("resource");
  if (resourceParam) {
    authRequest.resource = resourceParam as string;
  }

  try {
    // Filter requested scopes to only supported ones
    const requestedScopes = authRequest.scope ?? [];
    const effectiveScopes = requestedScopes.filter((s) =>
      (SCOPES_SUPPORTED as readonly string[]).includes(s)
    );

    // Complete authorization
    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: authRequest,
      userId: "operator",
      scope: effectiveScopes,
      metadata: { label: "operator" },
      props: { userId: "operator", scopes: effectiveScopes },
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
      userId: "operator",
      ok: true,
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

  const { grantId } = validation.data!;

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

  // C.5: Revoke grant via provider
  try {
    await c.env.OAUTH_PROVIDER.revokeGrant(grantId, "operator");
  } catch (error) {
    writeAudit(c.env, ctx, {
      event: "admin.revoke",
      grantId,
      ok: false,
      reason: "provider_error",
    });

    return c.json({ error: "revoke failed" }, 500);
  }

  // C.6: Success - audit and return
  writeAudit(c.env, ctx, {
    event: "admin.revoke",
    grantId,
    ok: true,
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
    });

    return c.json({ client_id: result.clientId }, 200);
  } catch (error) {
    writeAudit(c.env, ctx, {
      event: "admin.bootstrap",
      clientName,
      ok: false,
      reason: "provider_error",
    });

    return c.json({ error: "bootstrap failed" }, 500);
  }
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
      ${authRequest.resource ? `<input type="hidden" name="resource" value="${escapeHtml(typeof authRequest.resource === "string" ? authRequest.resource : authRequest.resource[0])}">` : ""}

      <label for="password">Password:</label>
      <input type="password" id="password" name="password" required autofocus>

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
  return str.replace(/[&<>"']/g, (char) => map[char]);
}

export default app;
