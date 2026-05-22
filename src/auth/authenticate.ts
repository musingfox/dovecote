/**
 * User credential authentication dispatcher (Contract A).
 *
 * Tries the KV-backed user store first (PBKDF2 verify); on miss falls back
 * to the legacy single-operator `OAUTH_PASSWORD` path. Returns `null` for
 * any authentication failure (no information leak); throws only when
 * underlying KV infrastructure fails.
 */

import type { Env } from "../types.js";
import { readUserRecord, normalizeUsername } from "./user-store.js";
import { verifyPassword } from "./password.js";
import { legacyAuthenticate } from "./legacy-auth.js";

export interface AuthenticateInput {
  submittedUsername: string;
  submittedPassword: string;
}

export interface AuthenticatedUser {
  userId: string;
  scopes: string[];
}

export async function authenticateUserCredentials(
  input: AuthenticateInput,
  env: Env,
): Promise<AuthenticatedUser | null> {
  const normalized = normalizeUsername(input.submittedUsername);

  // KV path: only attempted when username passes charset validation.
  if (normalized) {
    const record = await readUserRecord(input.submittedUsername, env);
    if (record) {
      const ok = await verifyPassword(input.submittedPassword, env.HMAC_PEPPER, {
        algo: record.algo,
        iterations: record.iterations,
        salt: record.salt,
        hash: record.hash,
      });
      if (ok) {
        return {
          userId: record.username,
          scopes: record.scopes,
        };
      }
      // KV record found but password wrong → fail; do NOT fall through to legacy
      return null;
    }
  } else {
    // Invalid charset → no KV read, no legacy fallback either
    return null;
  }

  // KV miss → try legacy
  return legacyAuthenticate(
    {
      submittedUsername: input.submittedUsername,
      submittedPassword: input.submittedPassword,
    },
    env,
  );
}
