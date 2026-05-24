#!/usr/bin/env bun
// Build-time OpenAPI 3.0 generator for dovecote /v1 routes.
// Run via `bun run openapi:gen` — emits `openapi.json` at repo root.
import { OpenApiGeneratorV3, OpenAPIRegistry, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { parseArgs } from "node:util";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  messageContentSchema,
  notifyRequestSchema as _notifyRequestSchema,
  sendResultSchema as _sendResultSchema,
  channelConfigSchema as _channelConfigSchema,
  channelsListResponseSchema as _channelsListResponseSchema,
} from "../src/contracts/notifications.ts";
import {
  profileNameSchema,
  envReadResponseSchema as _envReadResponseSchema,
} from "../src/contracts/env.ts";
import {
  tokenIssueRequestSchema,
  tokenIssueResponseSchema as _tokenIssueResponseSchema,
  tokenRevokeResponseSchema as _tokenRevokeResponseSchema,
  tokenExchangeRequestSchema as _tokenExchangeRequestSchema,
  tokenExchangeOidcRequestSchema as _tokenExchangeOidcRequestSchema,
  tokenRenewRequestSchema as _tokenRenewRequestSchema,
  tokenListResponseSchema as _tokenListResponseSchema,
} from "../src/contracts/tokens.ts";
import {
  deviceAuthorizeRequestSchema as _deviceAuthorizeRequestSchema,
  deviceAuthorizeResponseSchema as _deviceAuthorizeResponseSchema,
  deviceExchangeRequestSchema as _deviceExchangeRequestSchema,
  devicePollPendingResponseSchema as _devicePollPendingResponseSchema,
} from "../src/contracts/devices.ts";
import { errorEnvelopeSchema as _errorEnvelopeSchema } from "../src/contracts/errors.ts";
import { healthResponseSchema as _healthResponseSchema } from "../src/contracts/health.ts";
import { MIN_CLIENT_VERSION } from "../src/version.ts";

extendZodWithOpenApi(z);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const { values } = parseArgs({
  options: {
    out: { type: "string" },
  },
  allowPositionals: false,
});

const outPath = values.out ? resolve(values.out) : resolve(repoRoot, "openapi.json");

const registry = new OpenAPIRegistry();

// OpenAPI annotations applied here (not in src/contracts) so production bundle
// stays free of extendZodWithOpenApi.
const errorEnvelopeSchema = _errorEnvelopeSchema.openapi("ErrorEnvelope");

const errorResponse = (description) => ({
  description,
  content: { "application/json": { schema: errorEnvelopeSchema } },
});

const notifyRequestSchema = _notifyRequestSchema.openapi("NotifyRequest");

const profilePathSchema = profileNameSchema.openapi({
  param: { name: "profile", in: "path" },
  example: "dev",
});

const tokenIdPathSchema = z.string().min(1).openapi({
  param: { name: "tokenId", in: "path" },
  example: "tkn_01HZ...",
});

const tokenIssueRequestOpenapiSchema = tokenIssueRequestSchema.openapi("TokenIssueRequest");
const tokenExchangeRequestOpenapiSchema = _tokenExchangeRequestSchema.openapi("TokenExchangeRequest");
const tokenExchangeOidcRequestOpenapiSchema = _tokenExchangeOidcRequestSchema.openapi("TokenExchangeOidcRequest");
const tokenRenewRequestOpenapiSchema = _tokenRenewRequestSchema.openapi("TokenRenewRequest");
const deviceAuthorizeRequestSchema = _deviceAuthorizeRequestSchema.openapi("DeviceAuthorizeRequest");
const deviceAuthorizeResponseSchema = _deviceAuthorizeResponseSchema.openapi("DeviceAuthorizeResponse");
const deviceExchangeRequestSchema = _deviceExchangeRequestSchema.openapi("DeviceExchangeRequest");
const devicePollPendingResponseSchema = _devicePollPendingResponseSchema.openapi("DevicePollPendingResponse");

const sendResultSchema = _sendResultSchema.openapi("SendResult");
const channelConfigSchema = _channelConfigSchema.openapi("ChannelConfig");
// Rebuild channelsListSchema so its array element references the named
// ChannelConfig component (the source schema in src/contracts is annotation-free).
const channelsListSchema = z.object({
  channels: z.array(channelConfigSchema),
}).openapi("ChannelsList");
const envReadResponseSchema = _envReadResponseSchema.openapi("EnvReadResponse");
const tokenIssueResponseSchema = _tokenIssueResponseSchema.openapi("TokenIssueResponse");
const revokeResponseSchema = _tokenRevokeResponseSchema.openapi("RevokeResponse");
const tokenListResponseSchema = _tokenListResponseSchema.openapi("TokenListResponse");
const healthResponseSchema = _healthResponseSchema.openapi("HealthResponse");

const jsonOk = (schema, description = "ok") => ({
  description,
  content: { "application/json": { schema } },
});

// --- Common error responses for /v1 routes ---
const commonAuthErrors = {
  401: errorResponse("Missing or invalid Authorization header"),
  403: errorResponse("Insufficient scope for this resource"),
  500: errorResponse("Internal server error"),
};

const writeValidationErrors = {
  400: errorResponse("Request body failed zod validation"),
};

const notFoundError = {
  404: errorResponse("Resource not found"),
};

const adminRateLimitErrors = {
  429: errorResponse("Rate limit exceeded — Retry-After header indicates retry window"),
  503: errorResponse("Admin token revocation pressure circuit open"),
};

// --- Route registrations ---
registry.registerPath({
  method: "post",
  path: "/v1/notify",
  description: "Send a notification to the configured channel. Requires scope `dovecote:notify`.",
  request: {
    body: { content: { "application/json": { schema: notifyRequestSchema } } },
  },
  responses: {
    200: jsonOk(sendResultSchema, "Notification dispatched"),
    ...writeValidationErrors,
    ...commonAuthErrors,
    ...adminRateLimitErrors,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/channels",
  description: "List configured notification channels. Requires scope `dovecote:read`.",
  responses: {
    200: jsonOk(channelsListSchema, "Channels listed"),
    ...commonAuthErrors,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/env/{profile}",
  description: "Read an env profile value. Requires scope `dovecote:env:read`.",
  request: {
    params: z.object({ profile: profilePathSchema }),
  },
  responses: {
    200: jsonOk(envReadResponseSchema, "Env profile resolved"),
    ...notFoundError,
    ...commonAuthErrors,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/tokens",
  description:
    "List API tokens. Non-admin callers see their own tokens; admin callers can pass `?userId=` to filter or omit it for all-users listing. Results are sorted by `createdAt` descending, capped at 1000 entries with `truncated:true` when more exist.",
  request: {
    query: z.object({ userId: z.string().optional() }),
  },
  responses: {
    200: jsonOk(tokenListResponseSchema, "Tokens listed"),
    ...commonAuthErrors,
    ...adminRateLimitErrors,
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/tokens",
  description: "Issue a new API token. Requires scope `dovecote:admin`.",
  request: {
    body: { content: { "application/json": { schema: tokenIssueRequestOpenapiSchema } } },
  },
  responses: {
    201: jsonOk(tokenIssueResponseSchema, "Token issued"),
    ...writeValidationErrors,
    ...commonAuthErrors,
    ...adminRateLimitErrors,
  },
});

registry.registerPath({
  method: "delete",
  path: "/v1/tokens/{tokenId}",
  description: "Revoke an API token. Requires scope `dovecote:admin`.",
  request: {
    params: z.object({ tokenId: tokenIdPathSchema }),
  },
  responses: {
    200: jsonOk(revokeResponseSchema, "Token revoked"),
    ...notFoundError,
    ...commonAuthErrors,
    ...adminRateLimitErrors,
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/auth/exchange",
  description:
    "Exchange an OAuth bearer (with dovecote:admin scope) for a dvct_* runtime token.",
  request: {
    body: { content: { "application/json": { schema: tokenExchangeRequestOpenapiSchema } } },
  },
  responses: {
    201: jsonOk(tokenIssueResponseSchema, "Token issued"),
    ...writeValidationErrors,
    ...commonAuthErrors,
    ...adminRateLimitErrors,
  },
});

// Phase 4.3 OIDC carve-out (ADR 0001). Note the responses: this endpoint does
// NOT include a 403 in commonAuthErrors because there is no admin-scope gate
// here — the OIDC verify primitive returns 401 (untrusted_issuer /
// bad_signature / etc.) but never 403. We mirror commonAuthErrors's other
// entries (401, 500) explicitly.
registry.registerPath({
  method: "post",
  path: "/v1/auth/exchange-oidc",
  description:
    "Exchange an OIDC id_token (from an allow-listed issuer) for a dvct_* runtime token. New subjects are auto-provisioned with scope `dovecote:notify`.",
  request: {
    body: { content: { "application/json": { schema: tokenExchangeOidcRequestOpenapiSchema } } },
  },
  responses: {
    201: jsonOk(tokenIssueResponseSchema, "Token issued"),
    ...writeValidationErrors,
    401: errorResponse(
      "id_token failed verification (untrusted_issuer / bad_signature / bad_audience / expired_token / iat_skew / malformed_token / untrusted_subject)",
    ),
    403: errorResponse("Reserved — not currently returned by this endpoint"),
    429: errorResponse("Rate limit exceeded — Retry-After header indicates retry window"),
    500: errorResponse("Internal server error (e.g. KV write failure during auto-provision)"),
    503: errorResponse("Misconfigured — HMAC_PEPPER or OIDC_ISSUERS missing"),
  },
});

// Phase 4.4 RFC 8628 device-code carve-outs. Unauthenticated like
// /v1/auth/exchange-oidc — no 403 (no admin gate); 503 on misconfigured pepper.
registry.registerPath({
  method: "post",
  path: "/v1/auth/device-authorize",
  description:
    "RFC 8628 §3.1 device-authorization. Returns a device_code, user_code, and verification_uri. The user approves out-of-band at the verification page.",
  request: {
    body: { content: { "application/json": { schema: deviceAuthorizeRequestSchema } } },
  },
  responses: {
    200: jsonOk(deviceAuthorizeResponseSchema, "Device authorization issued"),
    ...writeValidationErrors,
    429: errorResponse("Rate limit exceeded — Retry-After header indicates retry window"),
    500: errorResponse("Internal server error (e.g. KV write failure)"),
    503: errorResponse("Misconfigured — HMAC_PEPPER not set"),
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/auth/exchange-device",
  description:
    "RFC 8628 §3.4 device-token endpoint. Polls with device_code until approval; success returns a dvct_* runtime token (one-shot — record becomes consumed).",
  request: {
    body: { content: { "application/json": { schema: deviceExchangeRequestSchema } } },
  },
  responses: {
    201: jsonOk(tokenIssueResponseSchema, "Token issued"),
    400: {
      description:
        "authorization_pending / slow_down / access_denied / expired_token / invalid_request / unsupported_grant_type",
      content: { "application/json": { schema: devicePollPendingResponseSchema } },
    },
    429: errorResponse("Rate limit exceeded — Retry-After header indicates retry window"),
    500: errorResponse("Internal server error"),
    503: errorResponse("Misconfigured — HMAC_PEPPER not set"),
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/tokens/{tokenId}/renew",
  description:
    "Renew a dvct_* token. Self-renew (own tokenId) requires no admin scope; admin can renew any tokenId.",
  request: {
    params: z.object({ tokenId: tokenIdPathSchema }),
    body: { content: { "application/json": { schema: tokenRenewRequestOpenapiSchema } } },
  },
  responses: {
    201: jsonOk(tokenIssueResponseSchema, "Token renewed"),
    ...writeValidationErrors,
    ...commonAuthErrors,
    ...notFoundError,
    ...adminRateLimitErrors,
  },
});

registry.registerPath({
  method: "get",
  path: "/health",
  description: "Public health probe — returns service status and minimum client version.",
  responses: {
    200: jsonOk(healthResponseSchema, "Service healthy"),
  },
});

// --- Generate ---
const generator = new OpenApiGeneratorV3(registry.definitions);
const doc = generator.generateDocument({
  openapi: "3.0.0",
  info: {
    title: "dovecote",
    version: MIN_CLIENT_VERSION,
  },
});

// --- Required schema verification (exit non-zero if any missing) ---
const requiredPaths = [
  "/v1/notify",
  "/v1/channels",
  "/v1/env/{profile}",
  "/v1/tokens",
  "/v1/tokens/{tokenId}",
  "/v1/tokens/{tokenId}/renew",
  "/v1/auth/exchange",
  "/v1/auth/exchange-oidc",
  "/v1/auth/device-authorize",
  "/v1/auth/exchange-device",
  "/health",
];
const emittedPaths = Object.keys(doc.paths ?? {});
const missing = requiredPaths.filter((p) => !emittedPaths.includes(p));
if (missing.length > 0) {
  console.error(`openapi:gen — missing required paths: ${missing.join(", ")}`);
  process.exit(1);
}

const requiredSchemas = [
  "ErrorEnvelope",
  "NotifyRequest",
  "SendResult",
  "ChannelConfig",
  "ChannelsList",
  "EnvReadResponse",
  "TokenIssueRequest",
  "TokenIssueResponse",
  "TokenExchangeRequest",
  "TokenExchangeOidcRequest",
  "TokenRenewRequest",
  "TokenListResponse",
  "RevokeResponse",
  "HealthResponse",
  "DeviceAuthorizeRequest",
  "DeviceAuthorizeResponse",
  "DeviceExchangeRequest",
  "DevicePollPendingResponse",
];
const emittedSchemas = Object.keys(doc.components?.schemas ?? {});
const missingSchemas = requiredSchemas.filter((s) => !emittedSchemas.includes(s));
if (missingSchemas.length > 0) {
  console.error(`openapi:gen — missing required component schemas: ${missingSchemas.join(", ")}`);
  process.exit(1);
}

// --- Write deterministic output ---
const serialized = JSON.stringify(doc, null, 2) + "\n";
await Bun.write(outPath, serialized);
console.log(`openapi:gen — wrote ${outPath} (${emittedPaths.length} paths, ${emittedSchemas.length} schemas)`);
