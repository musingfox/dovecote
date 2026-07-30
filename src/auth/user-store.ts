/**
 * KV-backed user record store (Contract E).
 *
 * Records live under `user:<lowercased-username>`. Usernames are normalized
 * via lowercasing, and must match a conservative charset
 * (`[a-z0-9_-]`, length 1-64) before any KV read — this prevents
 * attacker-controlled keys from probing arbitrary KV entries.
 */

import type { Env } from "../types.js";

const USERNAME_REGEX = /^[a-z0-9_-]{1,64}$/;

/**
 * Algorithm marker for a stored user record. `"pbkdf2-sha256"` survives as
 * inert data on legacy records (decision L4 — no verifier exists any more);
 * `"oidc"` is the placeholder marker for users provisioned via the OIDC
 * exchange (`salt`/`hash`/`iterations` are empty).
 */
export type UserRecordAlgo = "pbkdf2-sha256" | "oidc";

export interface UserRecord {
  username: string;
  algo: UserRecordAlgo;
  iterations: number;
  salt: string;
  hash: string;
  scopes: string[];
  createdAt?: string;
}

export function normalizeUsername(username: string): string | null {
  if (typeof username !== "string") return null;
  const lower = username.toLowerCase();
  if (!USERNAME_REGEX.test(lower)) return null;
  return lower;
}

export async function readUserRecord(
  username: string,
  env: Env,
): Promise<UserRecord | null> {
  const normalized = normalizeUsername(username);
  if (!normalized) return null;

  const raw = await env.OAUTH_KV.get(`user:${normalized}`);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.username !== "string" ||
      typeof parsed.algo !== "string" ||
      typeof parsed.iterations !== "number" ||
      typeof parsed.salt !== "string" ||
      typeof parsed.hash !== "string" ||
      !Array.isArray(parsed.scopes)
    ) {
      return null;
    }
    return parsed as UserRecord;
  } catch {
    return null;
  }
}
