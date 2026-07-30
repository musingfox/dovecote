/**
 * OIDC issuer-config shapes shared by the L2 GitHub Actions OIDC exchange
 * (src/auth-github-oidc.ts, src/auth/oidc-verify.ts).
 *
 * The CF Access RP flow and its issuer-allowlist env parser were removed in
 * M1 (decision L3); only the issuer-config schema and the clock-tolerance
 * helper remain.
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
