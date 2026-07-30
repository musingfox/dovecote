/**
 * resolveUserId seam (Contract H) — OIDC only (ResolveUserOidcOnly).
 *
 * Only the `oidc` variant remains: maps a verified OIDC subject claim to a
 * userId, auto-provisioning a placeholder `user:<id>` record with the default
 * scope on first login. Form arm removed (no more authenticateUserCredentials).
 */

import type { Env } from "../types.js";
import type { AuthenticatedUser } from "./authenticate.js";
import {
  readUserRecord,
  normalizeUsername,
  type UserRecord,
} from "./user-store.js";

/**
 * Default scope granted to a brand-new OIDC-provisioned user. Intentionally
 * narrow — admin elevation goes via the existing `bootstrap-admin-user`
 * runbook, not the exchange endpoint.
 */
export const OIDC_DEFAULT_SCOPES = ["dovecote:notify"] as const;

export type ResolveUserInput = { kind: "oidc"; issuer: string; subject: string };

export async function resolveUserId(
  input: ResolveUserInput,
  env: Env,
): Promise<AuthenticatedUser | null> {
  switch (input.kind) {
    case "oidc": {
      const normalized = normalizeUsername(input.subject);
      if (!normalized) {
        return null;
      }
      const existing = await readUserRecord(normalized, env);
      if (existing) {
        return {
          userId: existing.username,
          scopes: existing.scopes,
        };
      }
      // Auto-provision shape — D-AutoProvisionShape. The placeholder
      // password material (`salt`/`hash` empty, `iterations:0`) is
      // explicitly refused by `verifyPassword`
      // (see C-PasswordRejectsOidcAlgo).
      const record: UserRecord = {
        username: normalized,
        algo: "oidc",
        iterations: 0,
        salt: "",
        hash: "",
        scopes: [...OIDC_DEFAULT_SCOPES],
        createdAt: new Date().toISOString(),
      };
      // KV put errors propagate; caller (the exchange endpoint) maps to 500.
      await env.OAUTH_KV.put(`user:${normalized}`, JSON.stringify(record));
      return {
        userId: normalized,
        scopes: [...OIDC_DEFAULT_SCOPES],
      };
    }
  }
  // no default: exhaustive on single oidc kind
  return null;
}
