/**
 * OIDC issuer-config parser (Contract O — supports C-Endpoint-ExchangeOidc).
 *
 * Reads `env.OIDC_ISSUERS` (a JSON-encoded array of issuer configs) and
 * validates it. Missing or malformed config throws `OidcConfigError` so
 * the calling handler can surface a 503 `misconfigured` response.
 */

import { z } from "zod";
import type { Env } from "../types.js";

export const oidcIssuerConfigSchema = z.object({
  issuer: z.string().url(),
  jwks_uri: z.string().url(),
  audience: z.string().min(1),
  subClaim: z.string().optional(),
});
export type OidcIssuerConfig = z.infer<typeof oidcIssuerConfigSchema>;

export const oidcIssuersSchema = z.array(oidcIssuerConfigSchema).min(1);

export class OidcConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OidcConfigError";
  }
}

/**
 * Parse `env.OIDC_ISSUERS` into the allow-list. Throws OidcConfigError if:
 *  - the variable is unset / empty,
 *  - the JSON is malformed,
 *  - the parsed value fails the zod shape (e.g. empty array, missing fields).
 */
export function parseOidcIssuers(env: Env): OidcIssuerConfig[] {
  const raw = env.OIDC_ISSUERS;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new OidcConfigError("OIDC_ISSUERS is not configured");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new OidcConfigError(
      `OIDC_ISSUERS is not valid JSON: ${(e as Error).message}`,
    );
  }
  const validated = oidcIssuersSchema.safeParse(parsed);
  if (!validated.success) {
    throw new OidcConfigError(
      `OIDC_ISSUERS failed schema validation: ${validated.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return validated.data;
}

/**
 * Parse `env.OIDC_CLOCK_TOLERANCE_SEC` (decimal integer, seconds). Default 60.
 * Negative or non-numeric values fall back to the default.
 */
export function getOidcClockToleranceSec(env: Env): number {
  const raw = env.OIDC_CLOCK_TOLERANCE_SEC;
  if (typeof raw !== "string") return 60;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 60;
  return Math.floor(n);
}
