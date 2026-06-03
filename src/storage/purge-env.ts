import type { KVNamespace } from "@cloudflare/workers-types";

/**
 * Delete all KV keys with the `env:` prefix.
 * OAUTH_KV is a shared namespace — only env: prefixed keys are removed.
 * Returns the number of deleted entries.
 */
export async function purgeEnvKeys(kv: KVNamespace): Promise<number> {
  const { keys } = await kv.list({ prefix: "env:" });
  let deleted = 0;
  for (const { name } of keys) {
    await kv.delete(name);
    deleted++;
  }
  return deleted;
}
