/**
 * Legacy single-operator authentication fallback (Contract F).
 *
 * Backwards-compat path for deployments that still rely on the
 * `OAUTH_PASSWORD` env (no KV-seeded users). Matches a single configurable
 * operator username (default `"operator"`) and returns the full supported
 * scope set on success.
 */

import type { Env } from "../types.js";
import { SCOPES_SUPPORTED } from "./scopes.js";

function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export interface LegacyAuthInput {
  submittedUsername: string;
  submittedPassword: string;
}

export interface LegacyAuthResult {
  userId: string;
  scopes: string[];
}

export function legacyAuthenticate(
  input: LegacyAuthInput,
  env: Env,
): LegacyAuthResult | null {
  if (!env.OAUTH_PASSWORD) return null;

  const expectedUsername = env.LEGACY_OPERATOR_USERNAME ?? "operator";
  if (input.submittedUsername !== expectedUsername) return null;

  if (!timingSafeEqual(input.submittedPassword, env.OAUTH_PASSWORD)) {
    return null;
  }

  return {
    userId: expectedUsername,
    scopes: [...SCOPES_SUPPORTED],
  };
}
