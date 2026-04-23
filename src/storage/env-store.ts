import type { KVNamespace } from "@cloudflare/workers-types";

/**
 * Read environment profile from KV
 * Returns null if profile does not exist
 * Empty string is a valid value
 */
export async function readEnvProfile(
  kv: KVNamespace,
  profile: string
): Promise<string | null> {
  return kv.get(`env:${profile}`);
}
