import type { Env, ChannelConfig } from "../types.js";
import type { AuthCtx } from "../auth/ctx.js";
import { getChannelConfigs } from "../channels/registry.js";
import { ScopeError } from "./errors.js";

export function listChannels(env: Env, auth: AuthCtx): ChannelConfig[] {
  if (!auth.scopes.includes("dovecote:notify")) {
    throw new ScopeError("dovecote:notify");
  }

  return getChannelConfigs(env);
}
