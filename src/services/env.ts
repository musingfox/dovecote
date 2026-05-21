import type { ExecutionContext } from "@cloudflare/workers-types";
import type { Env } from "../types.js";
import type { AuthCtx } from "../auth/ctx.js";
import { readEnvProfile } from "../storage/env-store.js";
import { writeAudit } from "../auth/audit.js";
import { ScopeError, NotFoundError, UpstreamError } from "./errors.js";

export async function readEnv(
  env: Env,
  auth: AuthCtx,
  ctx: ExecutionContext,
  { profile }: { profile: string }
): Promise<string> {
  if (!auth.scopes.includes("dovecote:env:read")) {
    writeAudit(env, ctx, {
      event: "env.read",
      userId: auth.userId,
      profile,
      ok: false,
      reason: "forbidden",
      authMethod: auth.authMethod,
      ip: auth.ip,
      scope: "dovecote:env:read",
      ...(auth.tokenId ? { tokenId: auth.tokenId } : {}),
    });
    throw new ScopeError("dovecote:env:read");
  }

  let value: string | null;
  try {
    value = await readEnvProfile(env.OAUTH_KV, profile);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    writeAudit(env, ctx, {
      event: "env.read",
      userId: auth.userId,
      profile,
      ok: false,
      reason: msg,
      authMethod: auth.authMethod,
      ip: auth.ip,
      scope: "dovecote:env:read",
      ...(auth.tokenId ? { tokenId: auth.tokenId } : {}),
    });
    throw new UpstreamError(msg);
  }

  if (value === null) {
    writeAudit(env, ctx, {
      event: "env.read",
      userId: auth.userId,
      profile,
      ok: false,
      authMethod: auth.authMethod,
      ip: auth.ip,
      scope: "dovecote:env:read",
      ...(auth.tokenId ? { tokenId: auth.tokenId } : {}),
    });
    throw new NotFoundError(`Profile "${profile}" not found`);
  }

  writeAudit(env, ctx, {
    event: "env.read",
    userId: auth.userId,
    profile,
    ok: true,
    authMethod: auth.authMethod,
    ip: auth.ip,
    scope: "dovecote:env:read",
    ...(auth.tokenId ? { tokenId: auth.tokenId } : {}),
  });

  return value;
}
