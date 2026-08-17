#!/usr/bin/env bun
/**
 * dovecote channel-add (ChannelAddWritesKvRecord).
 *
 * Adds ONE channel by writing ONE `channel:<service>-<id>` KV record into the
 * chosen environment. No deployed worker is contacted, no other channel's
 * credentials are read or re-pasted, and no worker secret is touched.
 *
 * Usage:
 *   bun run channel:add -- --env staging
 *   bun run channel:add -- --env production          # asks you to type 'production'
 *   bun run channel:add -- --env staging --force     # allow overwriting an existing key
 *
 * `--env` is mandatory with no default and targeting production requires typing
 * `production` at the confirmation prompt (D-M4): per-key writes make the old
 * "clobber the whole array" accident impossible, so the remaining risk is aiming
 * at the wrong environment, which is asked directly instead of inferred from the
 * local CLI config. Overwriting an existing channel requires `--force`.
 */

import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { discordAdapter } from "../src/channels/discord.js";
import { telegramAdapter } from "../src/channels/telegram.js";
import {
  CHANNEL_KEY_PREFIX,
  channelKey,
  isValidInstanceId,
  serializeChannelRecord,
} from "../src/channels/utils.js";
import { makeWranglerKv, type WranglerRunner } from "./lib/wrangler-kv.js";

export type Service = "telegram" | "discord";

export interface TelegramAnswers {
  id: string;
  botToken: string;
  chatId: string;
}

export interface DiscordAnswers {
  id: string;
  webhookUrl: string;
}

export type ChannelAnswers = TelegramAnswers | DiscordAnswers;

export interface ChannelWrite {
  key: string;
  value: string;
}

const VALID_ENVS = ["staging", "production"];

/**
 * Turn the operator's answers into the single canonical KV write they imply, or
 * the bare reason they cannot be stored. Ids are lowercased here (D-M7) and the
 * record is validated with the same `parseRecord` the worker reads with, so a
 * channel that would be skipped at read time is refused at write time instead.
 */
export function buildChannelWrite(
  service: Service,
  answers: ChannelAnswers,
): ChannelWrite | { error: string } {
  const id = answers.id.toLowerCase();

  if (service === "telegram") {
    const parsed = telegramAdapter.parseRecord({ ...answers, service, id });
    if (!parsed.ok) return { error: parsed.error };
    return {
      key: channelKey("telegram", parsed.config.id),
      value: serializeChannelRecord("telegram", parsed.config),
    };
  }

  const parsed = discordAdapter.parseRecord({ ...answers, service, id });
  if (!parsed.ok) return { error: parsed.error };
  return {
    key: channelKey("discord", parsed.config.id),
    value: serializeChannelRecord("discord", parsed.config),
  };
}

export interface AddIo {
  /** Ask the operator one question and return their trimmed answer. */
  ask: (prompt: string) => Promise<string>;
  out?: (msg: string) => void;
  err?: (msg: string) => void;
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
 * `process.exit` and never spawns anything itself — every wrangler invocation
 * goes through the injected runner, so tests can record it.
 */
export async function runChannelAdd(
  argv: string[],
  runner: WranglerRunner,
  io: AddIo,
): Promise<number> {
  const out = io.out ?? ((msg: string) => process.stdout.write(msg + "\n"));
  const err = io.err ?? ((msg: string) => process.stderr.write(msg + "\n"));

  const envName = flagValue(argv, "env");
  if (envName === undefined || !VALID_ENVS.includes(envName)) {
    err(`✘ --env is required and must be one of: ${VALID_ENVS.join(", ")}`);
    return 1;
  }
  const force = argv.includes("--force");

  if (envName === "production") {
    const confirmation = await io.ask(
      "  This writes a live credential to PRODUCTION. Type 'production' to continue:",
    );
    if (confirmation.trim() !== "production") {
      err("✘ production not confirmed — nothing was written");
      return 1;
    }
  }

  const service = (await io.ask("  Service? [telegram / discord]")).trim().toLowerCase();
  if (service !== "telegram" && service !== "discord") {
    err(`✘ unsupported service '${service}' — expected 'telegram' or 'discord'`);
    return 1;
  }

  let instanceId = "";
  while (!instanceId) {
    const candidate = (
      await io.ask("  instance id (e.g. release, alerts, team-frontend):")
    ).trim().toLowerCase();
    if (!isValidInstanceId(candidate)) {
      out(`  ⚠ invalid id '${candidate}': must match [a-z0-9][a-z0-9-]* with no trailing or doubled dash`);
      continue;
    }
    instanceId = candidate;
  }

  let answers: ChannelAnswers;
  if (service === "telegram") {
    answers = {
      id: instanceId,
      botToken: (await io.ask("    bot token:")).trim(),
      chatId: (await io.ask("    chat id:")).trim(),
    };
  } else {
    answers = {
      id: instanceId,
      webhookUrl: (await io.ask("    webhook url:")).trim(),
    };
  }

  // An empty answer is a slip, not a credential: `parseRecord` accepts "" as a
  // string, so a blank prompt would otherwise be stored as a dead channel.
  const blank = Object.entries(answers).find(([, value]) => value === "");
  if (blank) {
    err(`✘ missing '${blank[0]}'`);
    return 1;
  }

  const built = buildChannelWrite(service, answers);
  if ("error" in built) {
    err(`✘ ${built.error}`);
    return 1;
  }

  const kv = makeWranglerKv(envName, runner);

  let existing: string | null;
  try {
    existing = await kv.get(built.key);
  } catch (e) {
    err(`✘ could not check whether ${built.key} exists: ${(e as Error).message}`);
    return 1;
  }
  if (existing !== null && !force) {
    err(
      `✘ ${built.key} already exists in ${envName} — re-run with --force to overwrite it`,
    );
    return 1;
  }

  out(`  writing ${built.key}...`);
  try {
    await kv.put(built.key, built.value);
  } catch (e) {
    err(`✘ ${(e as Error).message}`);
    return 1;
  }

  const channelId = built.key.slice(CHANNEL_KEY_PREFIX.length);
  out(`  ✓ ${built.key} written to ${envName}`);
  out(`    dovecote notify ${channelId} --text "hello from ${instanceId}"`);
  return 0;
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

if (import.meta.main) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const code = await runChannelAdd(process.argv.slice(2), wranglerRunner, {
    ask: async (prompt) => (await rl.question(`${prompt} `)).trim(),
  });
  rl.close();
  process.exit(code);
}
