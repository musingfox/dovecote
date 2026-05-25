/**
 * Request schema for `POST /admin/issue-token` — admin-bearer-gated mint of a
 * `dvct_*` runtime token without going through the OAuth bootstrap-client +
 * `/v1/auth/exchange` round-trip.
 *
 * Used by the setup-wizard for personal-CLI installs; external third-party
 * consumers continue to use the OAuth + `/v1/auth/exchange` path.
 */

import { z } from "zod";
import { SCOPES_SUPPORTED } from "../auth/scopes.js";

const USERNAME_REGEX = /^[a-z0-9_-]{1,64}$/;

/** Default token TTL for admin-issued tokens, in days. */
export const ADMIN_ISSUE_DEFAULT_DAYS = 90;
/** Max TTL accepted by `/admin/issue-token`, in days. */
export const ADMIN_ISSUE_MAX_DAYS = 90;
/** Min TTL accepted by `/admin/issue-token`, in days. */
export const ADMIN_ISSUE_MIN_DAYS = 1;
/** Default label written into the token record when the caller omits one. */
export const ADMIN_ISSUE_DEFAULT_LABEL = "operator";

export const adminIssueTokenRequestSchema = z.object({
  userId: z.string().regex(USERNAME_REGEX, "userId must match [a-z0-9_-]{1,64}"),
  scopes: z
    .array(z.enum(SCOPES_SUPPORTED))
    .min(1, "scopes must be a non-empty array of supported scopes"),
  expiresInDays: z
    .number()
    .int()
    .min(ADMIN_ISSUE_MIN_DAYS)
    .max(ADMIN_ISSUE_MAX_DAYS)
    .optional(),
  label: z.string().min(1).max(128).optional(),
});

export type AdminIssueTokenRequest = z.infer<typeof adminIssueTokenRequestSchema>;
