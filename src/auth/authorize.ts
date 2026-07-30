import { Hono } from "hono";
import type { Context } from "hono";
import type { ExecutionContext, KVNamespace } from "@cloudflare/workers-types";
import type { Env } from "../types.js";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { writeAudit } from "./audit.js";
import { checkRateLimit } from "./rate-limit.js";
import { verifyToken, KVWriteError, type VerifyOutcome } from "./api-token.js";
import { validateRevokeBody } from "./revoke-schema.js";
import { validateBootstrapBody } from "./bootstrap-schema.js";

/**
 * Injectable side-effect seams for the authorize form (V1Services-style).
 * Production uses the module default export (real implementations); tests
 * build their own app via `createAuthorizeApp({...stubs})`. No mutable
 * module-level state ships in the worker bundle.
 */
export interface AuthorizeServices {
  checkRateLimit: (
    kv: KVNamespace,
    ip: string,
    namespace?: string,
    limit?: number,
  ) => ReturnType<typeof checkRateLimit>;
  verifyToken: (token: string, env: Env) => Promise<VerifyOutcome>;
}

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
 * ExecutionContext shim — `c.executionCtx` throws when unavailable (e.g. some
 * test harnesses); substitute a no-op waitUntil so audit writes cannot take
 * down the request. Same pattern as /admin/revoke below.
 */
function shimExecutionCtx(c: Context<{ Bindings: AuthEnv }>): ExecutionContext {
  try {
    return c.executionCtx;
  } catch {
    return {
      waitUntil: (p: Promise<any>) => {
        p.catch(() => {});
      },
      passThroughOnException: () => {},
    } as any;
  }
}

/**
 * OAuth query parameters carried verbatim through the form round-trip (M1).
 * Everything the client sent on GET /authorize is re-emitted as hidden fields
 * — PKCE (`code_challenge`/`code_challenge_method`) included — and the POST
 * leg re-validates them via parseAuthRequest instead of trusting them.
 */
function collectOAuthParams(source: Iterable<[string, string]>): Array<[string, string]> {
  const params: Array<[string, string]> = [];
  for (const [name, value] of source) {
    if (name === "token") continue; // never collide with the credential field
    params.push([name, value]);
  }
  return params;
}

function renderAuthorizeForm(opts: {
  params: Array<[string, string]>;
  inlineError?: string;
}): string {
  const { params, inlineError } = opts;
  const clientId = params.find(([n]) => n === "client_id")?.[1] ?? "";
  const hiddenFields = params
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join("\n");
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize — Dovecote</title>
<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:40px auto;padding:16px}input,button{padding:8px;width:100%;box-sizing:border-box}form{display:flex;flex-direction:column;gap:8px}.err{color:#b00020;margin:8px 0}</style>
</head>
<body>
<h1>Authorize</h1>
<p>Paste your <code>dvct_*</code> token for <code>${escapeHtml(clientId)}</code>.</p>
${inlineError ? `<div class="err">${escapeHtml(inlineError)}</div>` : ""}
<form method="post" action="/authorize">
${hiddenFields}
<label>Token<br><input name="token" type="password" required placeholder="Paste your dvct token" autocomplete="off"></label>
<button type="submit">Authorize</button>
</form>
</body>
</html>`;
}

function registerAuthorizeFormRoutes(
  app: Hono<{ Bindings: AuthEnv }>,
  services: AuthorizeServices,
): void {
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

    // parseAuthRequest owns client_id/redirect_uri validation (turn-23/24 defenses).
    try {
      const req = await provider.parseAuthRequest(c.req.raw);
      // parsed clientId should match query; treat mismatch as invalid too
      if (!req.clientId || req.clientId !== clientId) {
        return c.json({ error: "invalid_redirect_uri" }, 400);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Invalid redirect URI") || msg.includes("Invalid client")) {
        return c.json({ error: "invalid_redirect_uri" }, 400);
      }
      return c.text("Internal Server Error", 500); // non-redirect parse errors (e.g. resource param)
    }

    const params = collectOAuthParams(new URL(c.req.url).searchParams.entries());
    return c.html(renderAuthorizeForm({ params }), 200, SECURITY_HEADERS);
  });

  /**
   * POST /authorize — rate-limit → re-validate hidden fields → verify token
   * → completeAuthorization (AuthorizeTokenGrant/Reject/RateLimit).
   */
  app.post("/authorize", async (c) => {
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const ctx = shimExecutionCtx(c);

    // 1. Rate limit BEFORE any token handling (M4).
    const rl = await services.checkRateLimit(c.env.OAUTH_KV, ip, "authorize", 5);
    if (!rl.allowed) {
      writeAudit(c.env, ctx, {
        event: "auth.authorize",
        ok: false,
        reason: "rate_limited",
        ip,
        authMethod: "none",
        scope: "",
      });
      return c.json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
    }

    const provider = c.env.OAUTH_PROVIDER;
    if (!provider) {
      return c.json({ error: "no_provider" }, 500);
    }

    const form = await c.req.formData();
    const token = (form.get("token") || "").toString().trim();

    // 2. Re-validate the hidden fields via a synthetic GET + parseAuthRequest (M1).
    //    The hidden fields themselves are NOT trusted; ANY parse failure —
    //    recognised or not — aborts with 400 before completeAuthorization.
    const qs = new URLSearchParams();
    for (const [name, value] of form.entries()) {
      if (name === "token" || typeof value !== "string") continue;
      qs.append(name, value);
    }
    const syntheticUrl = new URL(c.req.url);
    syntheticUrl.search = qs.toString();
    let authReq: AuthRequest;
    try {
      authReq = await provider.parseAuthRequest(
        new Request(syntheticUrl.toString(), { method: "GET" }),
      );
      if (!authReq.clientId) {
        return c.json({ error: "invalid_redirect_uri" }, 400);
      }
    } catch {
      return c.json({ error: "invalid_redirect_uri" }, 400);
    }

    const params = collectOAuthParams(qs.entries());

    // 3. Verify the pasted token.
    if (!token) {
      writeAudit(c.env, ctx, {
        event: "auth.authorize",
        ok: false,
        reason: "missing_token",
        ip,
        authMethod: "none",
        scope: "",
      });
      return c.html(
        renderAuthorizeForm({ params, inlineError: "Token required" }),
        400,
        SECURITY_HEADERS,
      );
    }

    let outcome: VerifyOutcome;
    try {
      outcome = await services.verifyToken(token, c.env);
    } catch (err) {
      if (err instanceof KVWriteError) {
        return c.json({ error: "internal_error" }, 500);
      }
      throw err;
    }

    if (outcome.kind !== "valid") {
      const expired = outcome.kind === "expired";
      writeAudit(c.env, ctx, {
        event: "auth.authorize",
        ok: false,
        reason: expired ? "expired_token" : "invalid_token",
        ip,
        authMethod: "none",
        scope: "",
      });
      return c.html(
        renderAuthorizeForm({
          params,
          inlineError: expired ? "Token expired" : "Invalid token",
        }),
        401,
        SECURITY_HEADERS,
      );
    }

    // 4. Complete the grant. request = the re-validated AuthRequest (PKCE
    //    carried through); scope = the token's stored scopes (M5); props
    //    carry the identity downstream (/v1/auth/exchange, /mcp).
    const auth = outcome.auth;
    try {
      const result = await provider.completeAuthorization({
        request: authReq,
        userId: auth.userId,
        scope: auth.scopes,
        props: {
          userId: auth.userId,
          scopes: auth.scopes,
          authMethod: "api_token",
        },
        metadata: {},
      });
      writeAudit(c.env, ctx, {
        event: "auth.authorize",
        ok: true,
        userId: auth.userId,
        authMethod: "api_token",
        ip,
        scope: auth.scopes.join(" "),
      });
      return c.redirect(result.redirectTo);
    } catch {
      return c.json({ error: "internal_error" }, 500);
    }
  });
}

/**
 * Health check endpoint
 */
const handleHealth = (c: Context<{ Bindings: AuthEnv }>) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
};

/**
 * POST /admin/revoke - Revoke an OAuth grant (Contract C)
 * Operator-only endpoint to immediately revoke grants (T1/T11/T17)
 */
const handleAdminRevoke = async (c: Context<{ Bindings: AuthEnv }>) => {
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
};

/**
 * POST /admin/bootstrap-client - Bootstrap OAuth client (Contract Bootstrap-Endpoint)
 * Flag-gated endpoint for operators to create OAuth clients
 */
const handleAdminBootstrapClient = async (c: Context<{ Bindings: AuthEnv }>) => {
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
};

/**
 * Build the default-handler app. `overrides` inject the authorize-form seams
 * (rate limiter / token verifier) for tests; production callers use the
 * module default export, which wires the real implementations.
 */
export function createAuthorizeApp(
  overrides: Partial<AuthorizeServices> = {},
): Hono<{ Bindings: AuthEnv }> {
  const services: AuthorizeServices = {
    checkRateLimit,
    verifyToken,
    ...overrides,
  };
  const app = new Hono<{ Bindings: AuthEnv }>();
  registerAuthorizeFormRoutes(app, services);
  app.get("/health", handleHealth);
  app.post("/admin/revoke", handleAdminRevoke);
  app.post("/admin/bootstrap-client", handleAdminBootstrapClient);
  // Fallback for unknown paths - 404
  app.all("*", (c) => {
    return c.text("Not Found", 404);
  });
  return app;
}

export default createAuthorizeApp();
