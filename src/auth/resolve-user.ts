/**
 * resolveUserId seam (Contract H).
 *
 * Discriminated-union entry point for user identification. Today only the
 * `form` variant is implemented (delegates to authenticateUserCredentials).
 * Future variants (e.g. OIDC id-token) plug in as additional `kind` arms
 * without changing call sites in 4.3/4.4.
 */

import type { Env } from "../types.js";
import {
  authenticateUserCredentials,
  type AuthenticatedUser,
} from "./authenticate.js";

export type ResolveUserInput =
  | { kind: "form"; username: string; password: string };

export async function resolveUserId(
  input: ResolveUserInput,
  env: Env,
): Promise<AuthenticatedUser | null> {
  switch (input.kind) {
    case "form":
      return authenticateUserCredentials(
        {
          submittedUsername: input.username,
          submittedPassword: input.password,
        },
        env,
      );
    default: {
      const _exhaustive: never = input.kind;
      void _exhaustive;
      return null;
    }
  }
}
