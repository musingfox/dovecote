/**
 * RFC 8628 device-code carve-out — `POST /v1/auth/device-authorize` and
 * `POST /v1/auth/exchange-device`.
 *
 * Mounted on the root app BEFORE the `/v1/*` bearer middleware (ADR 0001
 * carve-out): the authorize step is unauthenticated, and the exchange step
 * authenticates by *device_code*, not by `dvct_*` bearer.
 *
 * KV layout:
 *   device:<device_code>            JSON DeviceRecord, TTL 600 s at authorize.
 *   device_user:<normalized_code>   = device_code string (lookup), same TTL.
 *
 * State machine:
 *   pending → approved → consumed (terminal)
 *   pending → denied             (terminal)
 *   pending → TTL-expired
 *
 * TTL no-reset invariant: every rewrite of a `device:` record uses
 * `max(1, ceil((expiresAt - now)/1000))` so the countdown started at authorize
 * is never extended.
 */

import { Hono } from "hono";
import type { ExecutionContext, KVNamespace } from "@cloudflare/workers-types";
import type { Env } from "./types.js";
import {
  deviceAuthorizeRequestSchema,
  deviceExchangeRequestSchema,
  DEVICE_CODE_GRANT_TYPE,
  type DeviceRecord,
} from "./contracts/devices.js";
import { expiresInToSeconds } from "./contracts/tokens.js";
import {
  generateRandomBase64Url,
  KVWriteError,
  type IssueResult,
} from "./auth/api-token.js";
import type { RateLimitResult } from "./auth/rate-limit.js";
import { writeAudit } from "./auth/audit.js";
import {
  generateUserCode,
  normalizeUserCode,
} from "./auth/user-code.js";
import { issueTokenFlow } from "./auth/issue-token-flow.js";

export type DeviceServices = {
  issueToken: (
    params: { userId: string; scopes: string[]; label?: string; ttlSeconds?: number },
    env: Env,
  ) => Promise<IssueResult>;
  checkRateLimit: (
    kv: KVNamespace,
    ip: string,
    namespace: string,
  ) => Promise<RateLimitResult>;
};

type DeviceVars = { Bindings: Env };

/** Authorize TTL: 10 minutes (RFC 8628 sample). */
export const DEVICE_AUTHORIZE_TTL_SEC = 600;
/** Initial poll interval (RFC 8628 §3.5 default). */
export const DEVICE_POLL_INITIAL_SEC = 5;
/** Cap on the adaptive poll interval after `slow_down` bumps. */
export const DEVICE_POLL_MAX_SEC = 60;

const KEY_DEVICE = "device:";
const KEY_DEVICE_USER = "device_user:";

function fingerprint(normalizedUserCode: string): string {
  return normalizedUserCode.slice(0, 4);
}

/**
 * Compute the `expirationTtl` (seconds) to use when REWRITING a device record.
 * Preserves the original countdown started at authorize — never extends it,
 * and never emits 0 (which CF KV rejects).
 */
function remainingTtlSec(expiresAt: number, now: number): number {
  const remainingMs = expiresAt - now;
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

export function createAuthExchangeDeviceApp(services: DeviceServices) {
  const app = new Hono<DeviceVars>();

  // ----------------------------------------------------------------------
  // POST /v1/auth/device-authorize
  // ----------------------------------------------------------------------
  app.post("/v1/auth/device-authorize", async (c) => {
    const env = c.env;
    const ctx = c.executionCtx as ExecutionContext;
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const now = Date.now();

    // 1. HMAC_PEPPER precheck (we don't call issueToken here, but the device
    //    record will be turned into a token at exchange — surfacing the
    //    misconfig early prevents stranded pending records).
    if (!env.HMAC_PEPPER) {
      writeAudit(env, ctx, {
        event: "auth.device.authorize",
        ok: false,
        reason: "misconfigured",
        authMethod: "none",
        ip,
        scope: "",
      });
      return c.json(
        { error: "misconfigured", error_description: "HMAC_PEPPER not configured" },
        503,
      );
    }

    // 2. Per-IP rate limit (namespace "device").
    const rl = await services.checkRateLimit(env.OAUTH_KV, ip, "device");
    if (!rl.allowed) {
      writeAudit(env, ctx, {
        event: "auth.device.authorize",
        ok: false,
        reason: "rate_limited",
        authMethod: "none",
        ip,
        scope: "",
      });
      return c.json(
        { error: "rate_limited", error_description: "Too many requests" },
        429,
        { "Retry-After": "60" },
      );
    }

    // 3. Parse + validate body.
    let raw: unknown = {};
    try {
      const text = await c.req.text();
      if (text.length > 0) raw = JSON.parse(text);
    } catch {
      writeAudit(env, ctx, {
        event: "auth.device.authorize",
        ok: false,
        reason: "invalid_request",
        authMethod: "none",
        ip,
        scope: "",
      });
      return c.json(
        { error: "invalid_request", error_description: "Invalid JSON body" },
        400,
      );
    }
    const parsed = deviceAuthorizeRequestSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join(".") ?? "";
      const msg = issue?.message ?? "Invalid request";
      const desc = path ? `${path}: ${msg}` : msg;
      writeAudit(env, ctx, {
        event: "auth.device.authorize",
        ok: false,
        reason: "invalid_request",
        authMethod: "none",
        ip,
        scope: "",
      });
      return c.json(
        { error: "invalid_request", error_description: desc },
        400,
      );
    }
    const body = parsed.data;
    const requestedScopes = body.scope
      ? body.scope.split(" ").filter((s) => s.length > 0)
      : [];

    // 4. Generate device_code + user_code with collision retry.
    const deviceCode = generateRandomBase64Url(24);
    let userCode = generateUserCode();
    let normalized = normalizeUserCode(userCode.raw);
    let userKey = KEY_DEVICE_USER + normalized;
    let attempts = 0;
    try {
      while ((await env.OAUTH_KV.get(userKey)) !== null) {
        attempts++;
        if (attempts >= 5) {
          writeAudit(env, ctx, {
            event: "auth.device.authorize",
            ok: false,
            reason: "internal_error",
            authMethod: "none",
            ip,
            scope: "",
            clientId: body.client_id,
          });
          return c.json(
            { error: "internal_error", error_description: "user_code collision" },
            500,
          );
        }
        userCode = generateUserCode();
        normalized = normalizeUserCode(userCode.raw);
        userKey = KEY_DEVICE_USER + normalized;
      }
    } catch (e) {
      writeAudit(env, ctx, {
        event: "auth.device.authorize",
        ok: false,
        reason: "internal_error",
        authMethod: "none",
        ip,
        scope: "",
        clientId: body.client_id,
      });
      return c.json({ error: "internal_error", error_description: (e as Error).message }, 500);
    }

    // 5. Persist both KV keys.
    const record: DeviceRecord = {
      status: "pending",
      clientId: body.client_id,
      requestedScopes,
      intervalSec: DEVICE_POLL_INITIAL_SEC,
      lastPollMs: 0,
      createdAt: now,
      expiresAt: now + DEVICE_AUTHORIZE_TTL_SEC * 1000,
      userCode: userCode.display,
      ...(body.label ? { label: body.label } : {}),
      ...(body.expiresIn ? { expiresInRequested: body.expiresIn } : {}),
    };
    try {
      await env.OAUTH_KV.put(KEY_DEVICE + deviceCode, JSON.stringify(record), {
        expirationTtl: DEVICE_AUTHORIZE_TTL_SEC,
      });
      await env.OAUTH_KV.put(userKey, deviceCode, {
        expirationTtl: DEVICE_AUTHORIZE_TTL_SEC,
      });
    } catch (e) {
      writeAudit(env, ctx, {
        event: "auth.device.authorize",
        ok: false,
        reason: "internal_error",
        authMethod: "none",
        ip,
        scope: "",
        clientId: body.client_id,
      });
      return c.json({ error: "internal_error", error_description: (e as Error).message }, 500);
    }

    // 6. Build response. Origin comes from the request URL (not the Host
    //    header — proxies can lie). Always exposes `/device` at root.
    const origin = new URL(c.req.url).origin;
    const verificationUri = `${origin}/device`;
    const verificationUriComplete = `${verificationUri}?user_code=${encodeURIComponent(userCode.display)}`;

    writeAudit(env, ctx, {
      event: "auth.device.authorize",
      ok: true,
      authMethod: "none",
      ip,
      scope: requestedScopes.join(" "),
      clientId: body.client_id,
      userCodeFingerprint: fingerprint(normalized),
    });

    return c.json(
      {
        device_code: deviceCode,
        user_code: userCode.display,
        verification_uri: verificationUri,
        verification_uri_complete: verificationUriComplete,
        expires_in: DEVICE_AUTHORIZE_TTL_SEC,
        interval: DEVICE_POLL_INITIAL_SEC,
      },
      200,
    );
  });

  // ----------------------------------------------------------------------
  // POST /v1/auth/exchange-device
  // ----------------------------------------------------------------------
  app.post("/v1/auth/exchange-device", async (c) => {
    const env = c.env;
    const ctx = c.executionCtx as ExecutionContext;
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const now = Date.now();

    // 1. Misconfig precheck.
    if (!env.HMAC_PEPPER) {
      writeAudit(env, ctx, {
        event: "auth.device.exchange",
        ok: false,
        reason: "misconfigured",
        authMethod: "none",
        ip,
        scope: "",
      });
      return c.json(
        { error: "misconfigured", error_description: "HMAC_PEPPER not configured" },
        503,
      );
    }

    // 2. Per-IP rate limit. Distinct from the in-record poll interval enforcement.
    const rl = await services.checkRateLimit(env.OAUTH_KV, ip, "device-poll");
    if (!rl.allowed) {
      writeAudit(env, ctx, {
        event: "auth.device.exchange",
        ok: false,
        reason: "rate_limited",
        authMethod: "none",
        ip,
        scope: "",
      });
      return c.json(
        { error: "rate_limited", error_description: "Too many requests" },
        429,
        { "Retry-After": "60" },
      );
    }

    // 3. Parse body, mapping grant_type mismatch to its dedicated error.
    let raw: unknown = {};
    try {
      const text = await c.req.text();
      if (text.length > 0) raw = JSON.parse(text);
    } catch {
      writeAudit(env, ctx, {
        event: "auth.device.exchange",
        ok: false,
        reason: "invalid_request",
        authMethod: "none",
        ip,
        scope: "",
      });
      return c.json(
        { error: "invalid_request", error_description: "Invalid JSON body" },
        400,
      );
    }
    const parsed = deviceExchangeRequestSchema.safeParse(raw);
    if (!parsed.success) {
      writeAudit(env, ctx, {
        event: "auth.device.exchange",
        ok: false,
        reason: "invalid_request",
        authMethod: "none",
        ip,
        scope: "",
      });
      return c.json(
        { error: "invalid_request", error_description: parsed.error.issues[0]?.message ?? "Invalid request" },
        400,
      );
    }
    if (parsed.data.grant_type !== DEVICE_CODE_GRANT_TYPE) {
      writeAudit(env, ctx, {
        event: "auth.device.exchange",
        ok: false,
        reason: "unsupported_grant_type",
        authMethod: "none",
        ip,
        scope: "",
      });
      return c.json(
        { error: "unsupported_grant_type" },
        400,
      );
    }
    const deviceCode = parsed.data.device_code;
    const recordKey = KEY_DEVICE + deviceCode;

    // 4. Read record. Missing → expired_token.
    let record: DeviceRecord | null;
    try {
      record = (await env.OAUTH_KV.get(recordKey, "json")) as DeviceRecord | null;
    } catch (e) {
      writeAudit(env, ctx, {
        event: "auth.device.exchange",
        ok: false,
        reason: "internal_error",
        authMethod: "none",
        ip,
        scope: "",
      });
      return c.json(
        { error: "internal_error", error_description: (e as Error).message },
        500,
      );
    }
    if (!record) {
      writeAudit(env, ctx, {
        event: "auth.device.exchange",
        ok: false,
        reason: "expired_token",
        authMethod: "none",
        ip,
        scope: "",
      });
      return c.json({ error: "expired_token" }, 400);
    }

    // 5. Hard-expired or terminal → expired_token.
    if (record.expiresAt <= now || record.status === "consumed") {
      writeAudit(env, ctx, {
        event: "auth.device.exchange",
        ok: false,
        reason: "expired_token",
        authMethod: "none",
        ip,
        scope: "",
      });
      return c.json({ error: "expired_token" }, 400);
    }
    if (record.status === "denied") {
      writeAudit(env, ctx, {
        event: "auth.device.exchange",
        ok: false,
        reason: "access_denied",
        authMethod: "none",
        ip,
        scope: "",
      });
      return c.json({ error: "access_denied" }, 400);
    }

    const ttl = remainingTtlSec(record.expiresAt, now);

    // 6. Pending: enforce poll interval BEFORE updating last poll.
    if (record.status === "pending") {
      const gap = now - record.lastPollMs;
      const intervalMs = record.intervalSec * 1000;
      if (record.lastPollMs > 0 && gap < intervalMs) {
        const newInterval = Math.min(record.intervalSec + 5, DEVICE_POLL_MAX_SEC);
        const updated: DeviceRecord = {
          ...record,
          intervalSec: newInterval,
          lastPollMs: now,
        };
        await env.OAUTH_KV.put(recordKey, JSON.stringify(updated), {
          expirationTtl: ttl,
        });
        writeAudit(env, ctx, {
          event: "auth.device.exchange",
          ok: false,
          reason: "slow_down",
          authMethod: "none",
          ip,
          scope: "",
        });
        return c.json({ error: "slow_down", interval: newInterval }, 400);
      }
      // First poll OR poll-after-interval — just bump lastPollMs.
      const updated: DeviceRecord = { ...record, lastPollMs: now };
      await env.OAUTH_KV.put(recordKey, JSON.stringify(updated), {
        expirationTtl: ttl,
      });
      writeAudit(env, ctx, {
        event: "auth.device.exchange",
        ok: false,
        reason: "authorization_pending",
        authMethod: "none",
        ip,
        scope: "",
      });
      return c.json({ error: "authorization_pending" }, 400);
    }

    // 7. Approved → mark consumed FIRST (CAS-style), THEN mint token.
    //    Reversing the order closes a concurrent-poll race: if two polls see
    //    `approved` simultaneously, only the one whose `consumed` write lands
    //    first proceeds to issueToken — the other re-reads `consumed` and
    //    returns `expired_token`. Workers KV has no native CAS, so re-read +
    //    verify narrows (but does not eliminate) the race window from
    //    [read…issueToken…write] down to [re-read…write].
    if (record.status === "approved") {
      if (!record.userId || !record.scopes) {
        writeAudit(env, ctx, {
          event: "auth.device.exchange",
          ok: false,
          reason: "internal_error",
          authMethod: "none",
          ip,
          scope: "",
        });
        return c.json(
          { error: "internal_error", error_description: "approval record incomplete" },
          500,
        );
      }

      // 7a. Re-read + verify still-approved (best-effort CAS).
      let latest: DeviceRecord | null;
      try {
        latest = (await env.OAUTH_KV.get(recordKey, "json")) as DeviceRecord | null;
      } catch (e) {
        writeAudit(env, ctx, {
          event: "auth.device.exchange",
          ok: false,
          reason: "internal_error",
          authMethod: "none",
          ip,
          scope: "",
        });
        return c.json(
          { error: "internal_error", error_description: (e as Error).message },
          500,
        );
      }
      if (!latest || latest.status !== "approved" || latest.expiresAt <= now) {
        // Another concurrent poll already consumed it, or it expired in the
        // narrow window. Surface as expired_token (existing branch behavior).
        writeAudit(env, ctx, {
          event: "auth.device.exchange",
          ok: false,
          reason: "expired_token",
          authMethod: "none",
          ip,
          scope: "",
        });
        return c.json({ error: "expired_token" }, 400);
      }

      // 7b. Write `consumed` BEFORE issueToken. If this throws, we MUST NOT
      //     mint a token — trading availability for safety to prevent double
      //     minting on transient KV write failure.
      const consumed: DeviceRecord = { ...latest, status: "consumed" };
      try {
        await env.OAUTH_KV.put(recordKey, JSON.stringify(consumed), {
          expirationTtl: ttl,
        });
      } catch {
        writeAudit(env, ctx, {
          event: "auth.device.exchange",
          ok: false,
          reason: "consume_write_failed",
          userId: record.userId,
          authMethod: "none",
          ip,
          scope: record.scopes.join(" "),
        });
        return c.json(
          { error: "internal_error", error_description: "Failed to persist consume marker" },
          500,
        );
      }

      // 7c. Mint token via shared pipeline (RL already ran in step 2 above).
      // Note: `consumed` was written above (step 7b) BEFORE issueToken to close
      // the concurrent-poll race. The helper receives no checkRateLimit so it
      // skips the RL step and goes straight to issueToken.
      const ttlSeconds = record.expiresInRequested
        ? expiresInToSeconds(record.expiresInRequested as any)
        : undefined;
      return issueTokenFlow(c, {
        env,
        ctx,
        ip,
        userId: record.userId,
        scopes: record.scopes,
        label: record.label,
        ttlSeconds,
        rateLimitNamespace: "device-poll",
        authMethod: "none",
        auditEvent: "auth.device.exchange",
        auditScope: record.scopes.join(" "),
        successStatus: 201,
        invalidScopeOpts: { auditReason: "invalid_scope" },
        missingPepperOpts: { auditReason: "misconfigured" },
        services: {
          issueToken: services.issueToken,
          // checkRateLimit intentionally omitted — already ran in step 2.
        },
      });
    }

    // Unreachable — every status handled above.
    return c.json({ error: "expired_token" }, 400);
  });

  return app;
}
