import { z } from "zod";
import { expiresInSchema } from "./tokens.js";

/**
 * RFC 8628 §3.1 device-authorization request body.
 * `scope` is space-separated (RFC §3.1). `expiresIn`/`label` are dovecote-specific
 * carry-throughs to `issueToken` at the exchange step.
 */
export const deviceAuthorizeRequestSchema = z.object({
  client_id: z.string().min(1),
  scope: z.string().optional(),
  expiresIn: expiresInSchema.optional(),
  label: z.string().max(64).optional(),
});
export type DeviceAuthorizeRequest = z.infer<typeof deviceAuthorizeRequestSchema>;

/**
 * RFC 8628 §3.2 device-authorization response.
 */
export const deviceAuthorizeResponseSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string(),
  expires_in: z.number().int(),
  interval: z.number().int(),
});
export type DeviceAuthorizeResponse = z.infer<typeof deviceAuthorizeResponseSchema>;

/**
 * RFC 8628 §3.4 device-token request body.
 */
export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export const deviceExchangeRequestSchema = z.object({
  grant_type: z.string().min(1),
  device_code: z.string().min(1),
});
export type DeviceExchangeRequest = z.infer<typeof deviceExchangeRequestSchema>;

/**
 * Pending/slow_down poll response envelope.
 * (The success branch returns the existing TokenIssueResponse shape; failure
 * branches use ErrorEnvelope.)
 */
export const devicePollPendingResponseSchema = z.object({
  error: z.enum([
    "authorization_pending",
    "slow_down",
    "access_denied",
    "expired_token",
    "invalid_request",
    "unsupported_grant_type",
  ]),
  interval: z.number().int().optional(),
});
export type DevicePollPendingResponse = z.infer<typeof devicePollPendingResponseSchema>;

/**
 * KV record shape persisted at `device:<device_code>`.
 * Lifecycle: pending → approved → consumed (terminal);
 *            pending → denied (terminal);
 *            pending → TTL-expired.
 */
export type DeviceRecordStatus = "pending" | "approved" | "denied" | "consumed";

export interface DeviceRecord {
  status: DeviceRecordStatus;
  clientId: string;
  requestedScopes: string[];
  intervalSec: number;
  lastPollMs: number;
  createdAt: number;
  expiresAt: number;
  userCode: string; // display form (4-dash-4)
  label?: string;
  expiresInRequested?: string;
  // Populated only after the approval-page write.
  userId?: string;
  scopes?: string[];
}
