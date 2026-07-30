import { Hono } from "hono";
import type { Context } from "hono";
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { Env } from "../types.js";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { writeAudit } from "./audit.js";
import { checkRateLimit } from "./rate-limit.js";
import { verifyToken } from "./api-token.js";

// test hook for AuthorizeRateLimit (stub injection without full services refactor)
let rateLimitImpl: typeof checkRateLimit = checkRateLimit;
export function __setRateLimitForTest(fn: typeof checkRateLimit) { rateLimitImpl = fn; }

// test hook for grant verify
let verifyTokenImpl: typeof verifyToken = verifyToken;
export function __setVerifyTokenForTest(fn: typeof verifyToken) { verifyTokenImpl = fn; }
import { validateRevokeBody } from "./revoke-schema.js";
import { validateBootstrapBody } from "./bootstrap-schema.js";
import { resolveUserId } from "./resolve-user.js";
import { parseOidcIssuers, getOidcClockToleranceSec } from "./oidc-config.js";
import { verifyOidcIdToken } from "./oidc-verify.js";

const SECURITY_HEADERS = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
} as const;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return ch;
    }
  });
}

// Extend Env to include the OAUTH_PROVIDER helper
interface AuthEnv extends Env {
  OAUTH_PROVIDER: OAuthHelpers;
}

// (CF Access OIDC removed; GitHub OIDC and form authorize remain)

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
 * GET /authorize - renders dvct token paste form (M1)
 * Provider validates client_id; on success returns HTML form posting back to /authorize.
 */
app.get("/authorize", async (c) => {
  const provider = c.env.OAUTH_PROVIDER;
  if (!provider) {
    return c.json({ error: "no_provider" }, 500);
  }

  const clientId = c.req.query("client_id");
  if (!clientId) {
    return c.json({ error: "invalid_redirect_uri" }, 400);
  }

  // Use parseAuthRequest for validation so that redirect-val error tests (throw cases)
  // get correct 400/500 without editing that test file.
  let redirectUri = "";
  let state = "";
  let scope = "";
  let responseType = "code";
  try {
    const req = await provider.parseAuthRequest(c.req.raw);
    // parsed clientId should match query; treat mismatch as invalid too
    if (!req.clientId || req.clientId !== clientId) {
      return c.json({ error: "invalid_redirect_uri" }, 400);
    }
    redirectUri = req.redirectUri || "";
    state = req.state || "";
    scope = (req.scope || []).join(" ");
    responseType = req.responseType || "code";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Invalid redirect URI") || msg.includes("Invalid client")) {
      return c.json({ error: "invalid_redirect_uri" }, 400);
    }
    return c.text("Internal Server Error", 500);  // non-redirect parse errors (e.g. resource param) -> 500; explicit to avoid test runner noise
  }

  const html = renderAuthorizeForm({ clientId, responseType, redirectUri, state, scope });
  return c.html(html, 200, SECURITY_HEADERS);
});

function renderAuthorizeForm(opts: { clientId: string; responseType?: string; redirectUri?: string; state?: string; scope?: string; inlineError?: string }): string {
  const { clientId, responseType = "code", redirectUri = "", state = "", scope = "", inlineError } = opts;
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize — Dovecote</title>
<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:40px auto;padding:16px}input,button{padding:8px;width:100%;box-sizing:border-box}form{display:flex;flex-direction:column;gap:8px}.hidden{display:none}.err{color:#b00020;margin:8px 0}</style>
</head>
<body>
<h1>Authorize</h1>
<p>Paste your <code>dvct_*</code> token for <code>${escapeHtml(clientId)}</code>.</p>
${inlineError ? `<div class="err">${escapeHtml(inlineError)}</div>` : ""}
<form method="post" action="/authorize">
<input type="hidden" name="response_type" value="${escapeHtml(responseType)}">
<input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
<input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
<input type="hidden" name="state" value="${escapeHtml(state)}">
${scope ? `<input type="hidden" name="scope" value="${escapeHtml(scope)}">` : ""}
<label>Token<br><input name="token" type="text" required placeholder="dvct_..." autocomplete="off"></label>
<button type="submit">Authorize</button>
</form>
</body>
</html>`;
}

/**
 * POST /authorize - rate limited entry (before token verify)
 */
app.post("/authorize", async (c) => {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const kv = c.env.OAUTH_KV;
  const rl = await rateLimitImpl(kv as any, ip, "authorize", 5);
  if (!rl.allowed) {
    writeAudit(c.env, c.executionCtx as any, {
      event: "authorize",
      ok: false,
      reason: "rate_limited",
      ip,
      authMethod: "none",
      scope: "",
    } as any);
    return c.json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
  }

  const provider = c.env.OAUTH_PROVIDER;
  const form = await c.req.formData();
  const token = (form.get("token") || "").toString().trim();
  const clientId = (form.get("client_id") || "").toString();
  const redirectUri = (form.get("redirect_uri") || "").toString();
  const state = (form.get("state") || "").toString();
  const responseType = (form.get("response_type") || "code").toString();
  const scope = (form.get("scope") || "").toString();

  // validate via parse (T2 tamper detection) — use synthetic GET req (formData already read body)
  const parseQs = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state, response_type: responseType });
  const parseReq = new Request(`https://x/authorize?${parseQs}`, { method: "GET" });
  try {
    await provider.parseAuthRequest(parseReq);
  } catch (e: any) {
    const m = String(e?.message || e);
    if (/invalid redirect/i.test(m)) {
      return c.json({ error: "invalid_redirect_uri" }, 400);
    }
  }

  // rate passed, now verify token (T1)
  if (!token) {
    const html = renderAuthorizeForm({ clientId, responseType, redirectUri, state, scope, inlineError: "Token required" });
    writeAudit(c.env, c.executionCtx as any, { event: "authorize", ok: false, reason: "invalid_token", ip, authMethod: "none", scope: "" } as any);
    return c.html(html, 400, SECURITY_HEADERS);
  }
  let v;
  try {
    v = await verifyTokenImpl(token, c.env);
  } catch {
    v = { kind: "invalid" };
  }
  if (v.kind !== "valid" || !v.auth) {
    const errMsg = v && (v as any).kind === "expired" ? "Token expired" : "Invalid token";
    const reason = (v && (v as any).kind === "expired") ? "expired_token" : "invalid_token";
    const html = renderAuthorizeForm({ clientId, responseType, redirectUri, state, scope, inlineError: errMsg });
    writeAudit(c.env, c.executionCtx as any, { event: "authorize", ok: false, reason, ip, authMethod: "none", scope: "" } as any);
    return c.html(html, 401, SECURITY_HEADERS);
  }
  const auth = v.auth;
  try {
    const result = await provider.completeAuthorization({
      request: {
        clientId,
        redirectUri,
        state,
        scope: scope ? scope.split(" ") : auth.scopes,
        responseType,
      } as any,
      userId: auth.userId,
      // per T1: props.authMethod = api_token
      props: { authMethod: "api_token" } as any,
      scope: auth.scopes,
      metadata: {} as any,
    });
    // success 302
    writeAudit(c.env, c.executionCtx as any, {
      event: "authorize",
      ok: true,
      userId: auth.userId,
      authMethod: "api_token",
      ip,
      scope: auth.scopes.join(" "),
    } as any);
    return c.redirect(result.redirectTo);
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (/invalid redirect/i.test(msg)) {
      return c.json({ error: "invalid_redirect_uri" }, 400);
    }
    return c.json({ error: "invalid_redirect_uri" }, 400);
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
 * Fallback for unknown paths - 404
 */
app.all("*", (c) => {
  return c.text("Not Found", 404);
});

export default app;
