/**
 * wrangler-KV adapter (plan M7 / WizardLocalTokenMint).
 *
 * Implements the KV `put` surface used by `issueToken` (src/auth/api-token.ts)
 * on top of `wrangler kv key put --remote`, so the setup wizard can mint the
 * first dvct_* token locally while the HMAC computation and the three-key KV
 * layout stay single-sourced in production code.
 *
 * `--remote` is REQUIRED on wrangler 4.x: without it `kv key put` writes the
 * local miniflare cache, not the deployed worker's KV (seed-user lesson).
 * The TTL flag is `--ttl <seconds>` — wrangler 4.x has no `--expiration-ttl`.
 */

export interface WranglerRunResult {
  code: number;
  stdout?: string;
  stderr?: string;
}

/** Runner executes a wrangler argv (without the leading `wrangler`). */
export type WranglerRunner = (
  args: string[],
) => WranglerRunResult | Promise<WranglerRunResult>;

export interface WranglerKv {
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

/**
 * Build a KV-namespace-shaped adapter targeting `--binding OAUTH_KV --env <envName>`.
 * A non-zero runner exit throws, which `issueToken` wraps into KVWriteError.
 *
 * @param envName wrangler environment ("staging" | "production")
 * @param runner  executes the wrangler argv; injectable for tests
 * @param onWrite optional progress hook, called with the key before each write
 */
export function makeWranglerKv(
  envName: string,
  runner: WranglerRunner,
  onWrite?: (key: string) => void,
): WranglerKv {
  return {
    async put(key, value, options) {
      onWrite?.(key);
      const args = [
        "kv",
        "key",
        "put",
        "--remote",
        "--binding",
        "OAUTH_KV",
        key,
        value,
      ];
      if (options?.expirationTtl !== undefined) {
        args.push("--ttl", String(options.expirationTtl));
      }
      args.push("--env", envName);
      const res = await runner(args);
      if (res.code !== 0) {
        throw new Error(
          `wrangler kv key put failed for ${key} (exit ${res.code})${res.stderr ? `: ${res.stderr.trim()}` : ""}`,
        );
      }
    },
  };
}
