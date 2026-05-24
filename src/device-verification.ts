/**
 * RFC 8628 §3.3 verification page (`GET /device` + `POST /device`).
 *
 * Renders a form for an authenticated human to approve (or deny) a pending
 * device-code. Reuses the existing form-credential primitive
 * (`resolveUserId({kind:"form",...})`) and CSRF helpers from `src/auth/csrf.ts`.
 *
 * Mounted on the root app BEFORE the `/v1/*` bearer middleware (the device
 * approval surface is browser-only and uses cookies + CSRF, not a `dvct_*`
 * bearer).
 */

import { Hono } from "hono";
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { Env } from "./types.js";
import { generateCSRF, validateCSRF } from "./auth/csrf.js";
import { normalizeUserCode } from "./auth/user-code.js";
import {
  resolveUserId as defaultResolveUserId,
  type ResolveUserInput,
} from "./auth/resolve-user.js";
import type { AuthenticatedUser } from "./auth/authenticate.js";
import { writeAudit } from "./auth/audit.js";
import type { DeviceRecord } from "./contracts/devices.js";

const SECURITY_HEADERS = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
} as const;

const KEY_DEVICE = "device:";
const KEY_DEVICE_USER = "device_user:";

export type DeviceVerificationServices = {
  resolveUserId?: (input: ResolveUserInput, env: Env) => Promise<AuthenticatedUser | null>;
};

function fingerprint(normalized: string): string {
  return normalized.slice(0, 4);
}

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

function renderForm(opts: {
  csrfToken: string;
  userCode: string;
  inlineError?: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Approve device — Dovecote</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 420px; margin: 60px auto; padding: 20px; }
    label { display: block; margin-top: 14px; font-weight: 500; }
    input[type=text], input[type=password] {
      width: 100%; padding: 10px; box-sizing: border-box;
      border: 1px solid #ccc; border-radius: 4px;
    }
    button { margin-top: 16px; padding: 10px 20px; cursor: pointer; }
    .err { color: #b00020; margin-top: 10px; }
    .row { display: flex; gap: 8px; }
    .row button { flex: 1; }
  </style>
</head>
<body>
  <h1>Approve device</h1>
  <p>Enter the code shown on your device, then sign in to approve or deny.</p>
  <form method="POST" action="/device">
    <input type="hidden" name="csrf_token" value="${escapeHtml(opts.csrfToken)}">

    <label for="user_code">Device code:</label>
    <input type="text" id="user_code" name="user_code" required
      autocomplete="off" placeholder="Enter the code shown on your device"
      value="${escapeHtml(opts.userCode)}">

    <label for="username">Username:</label>
    <input type="text" id="username" name="username" required autocomplete="username">

    <label for="password">Password:</label>
    <input type="password" id="password" name="password" required autocomplete="current-password">

    ${opts.inlineError ? `<div class="err">${escapeHtml(opts.inlineError)}</div>` : ""}

    <div class="row">
      <button type="submit" name="action" value="approve">Approve</button>
      <button type="submit" name="action" value="deny">Deny</button>
    </div>
  </form>
</body>
</html>`;
}

function execCtxOrShim(c: any): ExecutionContext {
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

function remainingTtlSec(expiresAt: number, now: number): number {
  return Math.max(1, Math.ceil((expiresAt - now) / 1000));
}

export function createDeviceVerificationApp(
  services: DeviceVerificationServices = {},
) {
  const resolve = services.resolveUserId ?? defaultResolveUserId;
  const app = new Hono<{ Bindings: Env }>();

  // ---------------- GET /device ----------------
  app.get("/device", async (c) => {
    const url = new URL(c.req.url);
    const prefill = url.searchParams.get("user_code") ?? "";
    const { token, cookie } = await generateCSRF({
      secretKey: c.env.COOKIE_ENCRYPTION_KEY,
    });
    const html = renderForm({ csrfToken: token, userCode: prefill });
    return c.html(html, 200, {
      ...SECURITY_HEADERS,
      "Set-Cookie": cookie,
    });
  });

  // ---------------- POST /device ----------------
  app.post("/device", async (c) => {
    const env = c.env;
    const ctx = execCtxOrShim(c);
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";

    // 1. CSRF FIRST — never reads KV on a bad token.
    const isValidCsrf = await validateCSRF({
      request: c.req.raw,
      secretKey: env.COOKIE_ENCRYPTION_KEY,
    });
    if (!isValidCsrf) {
      return c.html("Invalid CSRF token", 400, SECURITY_HEADERS);
    }

    const form = await c.req.formData();
    const userCodeRaw = (form.get("user_code") as string | null) ?? "";
    const username = (form.get("username") as string | null) ?? "";
    const password = (form.get("password") as string | null) ?? "";
    const action = (form.get("action") as string | null) ?? "approve";

    const normalized = normalizeUserCode(userCodeRaw);

    // Helper to re-render the form with an inline error and a fresh CSRF.
    const renderError = async (status: 400 | 403, msg: string) => {
      const { token, cookie } = await generateCSRF({
        secretKey: env.COOKIE_ENCRYPTION_KEY,
      });
      const html = renderForm({
        csrfToken: token,
        userCode: userCodeRaw, // preserve so user can retry creds
        inlineError: msg,
      });
      return c.html(html, status, { ...SECURITY_HEADERS, "Set-Cookie": cookie });
    };

    // 2. Look up device_code via the user_code index.
    if (!normalized) {
      return renderError(400, "Code not recognized or expired");
    }
    const deviceCode = await env.OAUTH_KV.get(KEY_DEVICE_USER + normalized);
    if (!deviceCode) {
      return renderError(400, "Code not recognized or expired");
    }
    const recordKey = KEY_DEVICE + deviceCode;
    const record = (await env.OAUTH_KV.get(recordKey, "json")) as DeviceRecord | null;
    if (!record) {
      return renderError(400, "Code not recognized or expired");
    }
    const now = Date.now();
    if (record.expiresAt <= now || record.status !== "pending") {
      return renderError(400, "Code not recognized or expired");
    }

    // 3. Authenticate via shared form-credential primitive.
    const authed = await resolve(
      { kind: "form", username, password },
      env,
    );
    if (!authed) {
      return renderError(403, "Invalid credentials");
    }

    const ttl = remainingTtlSec(record.expiresAt, now);

    // 4. Approve / deny.
    if (action === "deny") {
      const updated: DeviceRecord = { ...record, status: "denied" };
      await env.OAUTH_KV.put(recordKey, JSON.stringify(updated), {
        expirationTtl: ttl,
      });
      writeAudit(env, ctx, {
        event: "auth.device.approve",
        ok: false,
        reason: "denied",
        userId: authed.userId,
        userCodeFingerprint: fingerprint(normalized),
        authMethod: "none",
        ip,
        scope: "",
      });
      return c.html("Device approval denied.", 200, SECURITY_HEADERS);
    }

    // Approve: filter scopes (requestedScopes ∩ user.scopes, else user.scopes).
    const userScopeSet = new Set(authed.scopes);
    const issuedScopes =
      record.requestedScopes.length > 0
        ? record.requestedScopes.filter((s) => userScopeSet.has(s))
        : authed.scopes;

    const updated: DeviceRecord = {
      ...record,
      status: "approved",
      userId: authed.userId,
      scopes: issuedScopes,
    };
    await env.OAUTH_KV.put(recordKey, JSON.stringify(updated), {
      expirationTtl: ttl,
    });

    writeAudit(env, ctx, {
      event: "auth.device.approve",
      ok: true,
      userId: authed.userId,
      userCodeFingerprint: fingerprint(normalized),
      authMethod: "none",
      ip,
      scope: issuedScopes.join(" "),
    });

    return c.html("Device approved. You may close this window.", 200, SECURITY_HEADERS);
  });

  return app;
}
