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
  /** Read one key back; `null` when the key does not exist. */
  get(key: string): Promise<string | null>;
}

/**
 * `wrangler kv key get --remote` on a missing key resolves the CF API
 * `.../values/<key>` endpoint to a 404, which wrangler surfaces as
 * `Failed to fetch <url> - 404: Not Found);` on a non-zero exit
 * (wrangler-dist/cli.js `fetchKVGetValue`). Anything else non-zero — auth,
 * network, bad namespace binding — is a real failure and must throw (A2).
 */
export function isKvKeyNotFound(res: WranglerRunResult): boolean {
  const text = `${res.stderr ?? ""}\n${res.stdout ?? ""}`;
  return /Failed to fetch/i.test(text) && /\b404\b/.test(text);
}

/**
 * `wrangler kv key get` logs `Getting value...` through its logger, which
 * writes to stdout (`console.log`), before streaming the raw value. Drop that
 * banner line so callers receive exactly the stored bytes.
 */
export function stripKvGetBanner(stdout: string): string {
  const newlineIndex = stdout.indexOf("\n");
  if (newlineIndex === -1) {
    return stdout;
  }
  const firstLine = stdout.slice(0, newlineIndex);
  if (/Getting value\.\.\./.test(firstLine)) {
    return stdout.slice(newlineIndex + 1);
  }
  return stdout;
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

    async get(key) {
      const args = [
        "kv",
        "key",
        "get",
        "--remote",
        "--binding",
        "OAUTH_KV",
        key,
        "--env",
        envName,
      ];
      const res = await runner(args);
      if (res.code !== 0) {
        if (isKvKeyNotFound(res)) {
          return null;
        }
        throw new Error(
          `wrangler kv key get failed for ${key} (exit ${res.code})${res.stderr ? `: ${res.stderr.trim()}` : ""}`,
        );
      }
      return stripKvGetBanner(res.stdout ?? "");
    },
  };
}
