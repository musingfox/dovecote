#!/usr/bin/env bun
/**
 * Backfill the `apitoken_user:<userId>:<tokenId>` per-user index for tokens
 * issued before Phase 4.3 (the index didn't exist; only `apitoken:<tokenId>`
 * and `apitoken_hash:<hash>` records were written).
 *
 * Strategy:
 *   1. wrangler kv key list --prefix apitoken: → enumerate canonical records,
 *      filtering out other namespaces that share the byte prefix (apitoken_hash:,
 *      apitoken_user:).
 *   2. For each canonical key, wrangler kv key get → JSON parse → extract
 *      {userId, tokenId}.
 *   3. wrangler kv key put apitoken_user:<userId>:<tokenId> "" (only when
 *      `--apply` is passed; default is `--dry-run`).
 *
 * Usage:
 *   bun scripts/backfill-apitoken-user-index.mjs [--dry-run] [--apply]
 *     [--binding OAUTH_KV]
 *
 * The `runBackfill({exec, argv, stdout, stderr})` export is the unit-testable
 * core — pass a stub `exec` to simulate wrangler in tests.
 */
import { parseArgs } from "node:util";
import { $ } from "bun";

/**
 * Default exec adapter: spawns `wrangler` via Bun.$ and returns {stdout, stderr, exitCode}.
 * If the binary is missing on PATH, returns a synthetic exitCode=127 result that
 * runBackfill catches and converts to a fail-fast exit 2.
 */
async function defaultExec(cmd, args) {
  try {
    const res = await $`${cmd} ${args}`.nothrow().quiet();
    return {
      stdout: res.stdout.toString(),
      stderr: res.stderr.toString(),
      exitCode: res.exitCode,
    };
  } catch (e) {
    return { stdout: "", stderr: String(e?.message ?? e), exitCode: 127 };
  }
}

/**
 * Filter raw `wrangler kv key list` output (JSON array of {name: string}) down
 * to canonical apitoken:<tokenId> keys, excluding apitoken_hash: and apitoken_user:
 * which share a common byte prefix.
 */
function filterCanonicalKeys(raw) {
  const items = JSON.parse(raw);
  if (!Array.isArray(items)) return [];
  return items
    .map((entry) => entry?.name)
    .filter(
      (name) =>
        typeof name === "string" &&
        name.startsWith("apitoken:") &&
        !name.startsWith("apitoken_")
    );
}

/**
 * Pure, testable backfill body.
 *
 * @param {Object} opts
 * @param {(cmd: string, args: string[]) => Promise<{stdout: string, stderr: string, exitCode: number}>} opts.exec
 * @param {string[]} opts.argv
 * @param {(s: string) => void} [opts.stdout]
 * @param {(s: string) => void} [opts.stderr]
 * @returns {Promise<number>} exit code
 */
export async function runBackfill(opts) {
  const stdout = opts.stdout ?? ((s) => process.stdout.write(s));
  const stderr = opts.stderr ?? ((s) => process.stderr.write(s));

  let values;
  try {
    const res = parseArgs({
      args: opts.argv,
      options: {
        "dry-run": { type: "boolean" },
        apply: { type: "boolean" },
        binding: { type: "string" },
      },
      allowPositionals: false,
      strict: true,
    });
    values = res.values;
  } catch (e) {
    stderr(`backfill: ${e?.message ?? e}\n`);
    return 2;
  }

  const apply = !!values.apply;
  // Dry-run is the default — only `--apply` switches to mutating mode.
  const dryRun = !apply;
  const binding = values.binding ?? "OAUTH_KV";

  // List canonical apitoken: keys. (wrangler kv key list does not accept --limit;
  // it streams the entire prefix back as a JSON array.)
  const listRes = await opts.exec("wrangler", [
    "kv",
    "key",
    "list",
    "--binding",
    binding,
    "--prefix",
    "apitoken:",
  ]);
  if (listRes.exitCode === 127) {
    stderr("backfill: wrangler not found on PATH\n");
    return 2;
  }
  if (listRes.exitCode !== 0) {
    stderr(`backfill: wrangler kv key list failed: ${listRes.stderr}\n`);
    return 1;
  }

  let canonicalKeys;
  try {
    canonicalKeys = filterCanonicalKeys(listRes.stdout);
  } catch (e) {
    stderr(`backfill: cannot parse list output: ${e?.message ?? e}\n`);
    return 1;
  }

  let scanned = 0;
  let wouldWrite = 0;
  let written = 0;
  let skipped = 0;
  let errored = 0;

  for (const key of canonicalKeys) {
    scanned++;
    const tokenId = key.slice("apitoken:".length);
    const getRes = await opts.exec("wrangler", [
      "kv",
      "key",
      "get",
      "--binding",
      binding,
      key,
    ]);
    if (getRes.exitCode !== 0) {
      errored++;
      continue;
    }
    let meta;
    try {
      meta = JSON.parse(getRes.stdout);
    } catch {
      errored++;
      continue;
    }
    if (
      !meta ||
      typeof meta.userId !== "string" ||
      typeof meta.tokenId !== "string"
    ) {
      errored++;
      continue;
    }
    // Defensive: keep tokenId from KV key (canonical) over metadata field.
    const indexKey = `apitoken_user:${meta.userId}:${tokenId}`;

    if (dryRun) {
      wouldWrite++;
      continue;
    }
    const putRes = await opts.exec("wrangler", [
      "kv",
      "key",
      "put",
      "--binding",
      binding,
      indexKey,
      "",
    ]);
    if (putRes.exitCode !== 0) {
      errored++;
      continue;
    }
    written++;
  }

  const summary = {
    scanned,
    wouldWrite,
    written,
    skipped,
    errored,
    mode: dryRun ? "dry-run" : "apply",
  };
  stdout(JSON.stringify(summary) + "\n");
  return 0;
}

// Script entry — only runs when invoked directly, not when imported by tests.
if (import.meta.main) {
  const code = await runBackfill({ exec: defaultExec, argv: process.argv.slice(2) });
  process.exit(code);
}
