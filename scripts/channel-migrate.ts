#!/usr/bin/env bun
/**
 * dovecote channel migration (ChannelMigrateWritesKvRecords).
 *
 * One-shot: pour the JSON you saved from the old per-service channel worker
 * secrets into this command and every channel appears as a
 * `channel:<service>-<id>` KV record in the chosen environment.
 *
 * Usage:
 *   bun run channel:migrate -- --env staging --file backup.json
 *   bun run channel:migrate -- --env production --file backup.json  # asks you to type 'production'
 *   bun run channel:migrate -- --env production --dry-run < backup.json
 *
 * Input document: { "telegram"?: Array | string, "discord"?: Array | string }
 * — a string value is parsed as JSON first, so the raw env-var body can be
 * pasted verbatim without hand-unwrapping it (D-M5).
 *
 * `--env` is mandatory with no default and a real write to production requires
 * typing `production` at the confirmation prompt, exactly as `channel:add`
 * does (D-M4): one run pours several live credentials into a namespace, so
 * aiming at the wrong environment is the standing risk and it is asked
 * directly. `--dry-run` writes nothing and is therefore never prompted.
 *
 * Validate-all-then-write (D-M5): if any entry fails validation nothing is
 * written at all. Writes are unconditional puts, so a re-run converges to the
 * same state and repairs a hand-edited record.
 */

import { createInterface } from "node:readline/promises";
import { createReadStream, createWriteStream, closeSync, openSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { discordAdapter } from "../src/channels/discord.js";
import { telegramAdapter } from "../src/channels/telegram.js";
import { channelKey, serializeChannelRecord } from "../src/channels/utils.js";
import { makeWranglerKv, type WranglerRunner } from "./lib/wrangler-kv.js";

export interface ChannelWrite {
  key: string;
  value: string;
}

export type MigrationPlan = { writes: ChannelWrite[] } | { errors: string[] };

const SERVICES = ["telegram", "discord"] as const;
type Service = (typeof SERVICES)[number];

const VALID_ENVS = ["staging", "production"];

/** Placeholder in an error's key when the entry's id is not even a string. */
const UNKNOWN_ID = "?";

/**
 * Turn one migration document into the exact set of KV writes it implies.
 * Every entry is validated with the production `parseRecord`; the returned
 * value is either a complete plan or the complete list of reasons it cannot
 * be executed — never a partial plan.
 */
export function planMigration(input: unknown): MigrationPlan {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      errors: ["input must be a JSON object with 'telegram' and/or 'discord' keys"],
    };
  }

  const doc = input as Record<string, unknown>;
  const writes: ChannelWrite[] = [];
  const errors: string[] = [];

  for (const key of Object.keys(doc)) {
    if (!(SERVICES as readonly string[]).includes(key)) {
      errors.push(`unknown service '${key}' — expected 'telegram' or 'discord'`);
    }
  }

  for (const service of SERVICES) {
    const raw = doc[service];
    if (raw === undefined) {
      continue;
    }

    let entries: unknown;
    if (typeof raw === "string") {
      try {
        entries = JSON.parse(raw);
      } catch {
        errors.push(`${service}: value is a string but not valid JSON`);
        continue;
      }
    } else {
      entries = raw;
    }

    if (!Array.isArray(entries)) {
      errors.push(`${service}: expected an array of channel entries`);
      continue;
    }

    for (const entry of entries) {
      const result = planEntry(service, entry);
      if ("error" in result) {
        errors.push(result.error);
      } else {
        writes.push(result.write);
      }
    }
  }

  if (errors.length > 0) {
    return { errors };
  }
  return { writes };
}

function planEntry(
  service: Service,
  entry: unknown,
): { write: ChannelWrite } | { error: string } {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return {
      error: `${channelKey(service, UNKNOWN_ID)}: record must be an object`,
    };
  }

  const fields = entry as Record<string, unknown>;
  // Id lowercasing is the writer's job (D-M7); parseRecord rejects uppercase.
  const id = typeof fields["id"] === "string" ? fields["id"].toLowerCase() : fields["id"];
  const candidate = { ...fields, service, id };
  const intendedKey = channelKey(service, typeof id === "string" ? id : UNKNOWN_ID);

  if (service === "telegram") {
    const parsed = telegramAdapter.parseRecord(candidate);
    if (!parsed.ok) {
      return { error: `${intendedKey}: ${parsed.error}` };
    }
    return {
      write: {
        key: channelKey("telegram", parsed.config.id),
        value: serializeChannelRecord("telegram", parsed.config),
      },
    };
  }

  const parsed = discordAdapter.parseRecord(candidate);
  if (!parsed.ok) {
    return { error: `${intendedKey}: ${parsed.error}` };
  }
  return {
    write: {
      key: channelKey("discord", parsed.config.id),
      value: serializeChannelRecord("discord", parsed.config),
    },
  };
}

export interface MigrateIo {
  out?: (msg: string) => void;
  err?: (msg: string) => void;
  /** Overrides `--file` / stdin; injected by tests to stay off the filesystem. */
  readInput?: () => Promise<string>;
  /**
   * Ask the operator one question and return their trimmed answer. Only the
   * production confirmation uses it. Absent means "cannot ask", which is
   * treated as "not confirmed" rather than as consent.
   */
  ask?: (prompt: string) => Promise<string>;
}

function flagValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  const next = argv[idx + 1];
  if (next === undefined || next.startsWith("--")) return undefined;
  return next;
}

/**
 * Drive the whole command in-process and return the exit code. Never calls
 * `process.exit`, so tests can run it with a recording runner.
 */
export async function runChannelMigrate(
  argv: string[],
  runner: WranglerRunner,
  io: MigrateIo = {},
): Promise<number> {
  const out = io.out ?? ((msg: string) => process.stdout.write(msg + "\n"));
  const err = io.err ?? ((msg: string) => process.stderr.write(msg + "\n"));

  const envName = flagValue(argv, "env");
  if (envName === undefined || !VALID_ENVS.includes(envName)) {
    err(`✘ --env is required and must be one of: ${VALID_ENVS.join(", ")}`);
    return 1;
  }
  const dryRun = argv.includes("--dry-run");

  // Same gate, same wording as `channel:add` (scripts/channel-add.ts). A
  // dry run is exempt because it puts nothing anywhere.
  if (envName === "production" && !dryRun) {
    const ask = io.ask ?? (async () => "");
    const confirmation = await ask(
      "  This writes live credentials to PRODUCTION. Type 'production' to continue:",
    );
    if (confirmation.trim() !== "production") {
      err("✘ production not confirmed — nothing was written");
      return 1;
    }
  }

  let text: string;
  try {
    text = await readDocument(argv, io);
  } catch (e) {
    err(`✘ could not read input: ${(e as Error).message}`);
    return 1;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    err(`✘ input is not valid JSON: ${(e as Error).message}`);
    return 1;
  }

  const plan = planMigration(parsed);
  if ("errors" in plan) {
    err(`✘ ${plan.errors.length} invalid channel record(s) — nothing was written:`);
    for (const message of plan.errors) err(`  ${message}`);
    return 1;
  }

  if (plan.writes.length === 0) {
    out("no channels in input — nothing to write");
    return 0;
  }

  if (dryRun) {
    for (const write of plan.writes) out(`${write.key} → would write`);
    out(`would write ${plan.writes.length} channel record(s) to ${envName}`);
    return 0;
  }

  const kv = makeWranglerKv(envName, runner);
  for (const write of plan.writes) {
    try {
      await kv.put(write.key, write.value);
    } catch (e) {
      err(`✘ failed writing ${write.key}: ${(e as Error).message}`);
      err("  earlier keys stay written — fix the cause and re-run to converge.");
      return 1;
    }
    out(`${write.key} → written`);
  }

  out(`wrote ${plan.writes.length} channel record(s) to ${envName}`);
  out("verify with: dovecote channels list");
  return 0;
}

async function readDocument(argv: string[], io: MigrateIo): Promise<string> {
  if (io.readInput) return await io.readInput();
  const file = flagValue(argv, "file");
  if (file !== undefined) return readFileSync(file, "utf8");
  return await Bun.stdin.text();
}

const wranglerRunner: WranglerRunner = (args) => {
  const res = spawnSync("wrangler", args, {
    stdio: ["inherit", "pipe", "pipe"],
    encoding: "utf8",
  });
  return {
    code: res.status ?? -1,
    stdout: (res.stdout as string) ?? "",
    stderr: (res.stderr as string) ?? "",
  };
};

/**
 * Ask on the controlling terminal rather than on stdin: the migration document
 * itself may be arriving on stdin (`... | bun run channel:migrate`), so the
 * prompt cannot share that channel the way `channel:add`'s can. With no
 * terminal at all (CI, cron, `</dev/null`) there is nobody to ask, so the
 * answer is empty and the caller refuses to write.
 */
async function askOnTerminal(prompt: string): Promise<string> {
  try {
    closeSync(openSync("/dev/tty", "r"));
  } catch {
    process.stderr.write(
      "  no terminal available to confirm production — re-run interactively\n",
    );
    return "";
  }
  const input = createReadStream("/dev/tty");
  const output = createWriteStream("/dev/tty");
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(`${prompt} `)).trim();
  } finally {
    rl.close();
    input.destroy();
    output.destroy();
  }
}

if (import.meta.main) {
  process.exit(
    await runChannelMigrate(process.argv.slice(2), wranglerRunner, {
      ask: askOnTerminal,
    }),
  );
}
