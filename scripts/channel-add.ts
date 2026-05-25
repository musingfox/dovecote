#!/usr/bin/env bun
/**
 * dovecote channel-add wizard
 *
 * Appends a new Telegram or Discord instance to the existing
 * `TELEGRAM_INSTANCES` / `DISCORD_INSTANCES` secret without clobbering
 * the others. Reads the current value (if any) via `wrangler secret list`
 * — since secret VALUES can't be read back, the script fetches current
 * channels from the deployed worker via `dovecote channels list` to
 * detect existing instance ids and refuses duplicates. The full JSON
 * (existing + new) is then re-pushed via `wrangler secret put`.
 *
 * The "existing values" themselves still have to be supplied by the
 * operator (since CF doesn't return secret bodies). The script prompts
 * for each detected existing instance to re-paste its bot token / chat
 * id / webhook URL once, then assembles + pushes the full new JSON.
 *
 * Usage:
 *   bun run channel:add
 *   bun run channel:add -- --env staging        # default
 *   bun run channel:add -- --env production
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr, env, argv, exit } from "node:process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// ---------- arg parsing ----------

const args = argv.slice(2);
function flag(name: string, def: string | boolean = ""): string | boolean {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return def;
  const next = args[idx + 1];
  if (next === undefined || next.startsWith("--")) return true;
  return next;
}

const envName = (flag("env", "staging") as string) || "staging";

if (envName !== "staging" && envName !== "production") {
  stderr.write(`✘ --env must be 'staging' or 'production' (got: ${envName})\n`);
  exit(1);
}

// ---------- IO ----------

const rl = createInterface({ input: stdin, output: stdout });

async function ask(prompt: string, def?: string): Promise<string> {
  const suffix = def !== undefined ? ` [${def}]` : "";
  const ans = await rl.question(`${prompt}${suffix} `);
  return ans.trim() || def || "";
}

async function askSecret(prompt: string): Promise<string> {
  const ans = await rl.question(`${prompt} `);
  return ans.trim();
}

async function askYesNo(prompt: string, def = true): Promise<boolean> {
  const tag = def ? "[Y/n]" : "[y/N]";
  const ans = (await rl.question(`${prompt} ${tag} `)).trim().toLowerCase();
  if (ans === "") return def;
  return ans === "y" || ans === "yes";
}

function info(msg: string): void {
  stdout.write(`  ${msg}\n`);
}
function ok(msg: string): void {
  stdout.write(`  ✓ ${msg}\n`);
}
function warn(msg: string): void {
  stdout.write(`  ⚠ ${msg}\n`);
}
function fail(msg: string): never {
  stderr.write(`  ✘ ${msg}\n`);
  rl.close();
  exit(1);
}

// ---------- shell helpers ----------

function wrangler(args: string[], opts: { capture?: boolean; stdin?: string } = {}) {
  const r = spawnSync("wrangler", args, {
    stdio: opts.capture ? ["pipe", "pipe", "pipe"] : ["inherit", "inherit", "inherit"],
    input: opts.stdin,
    encoding: "utf8",
  });
  return {
    code: r.status ?? -1,
    stdout: (r.stdout as string) ?? "",
    stderr: (r.stderr as string) ?? "",
  };
}

function dovecote(args: string[]) {
  const r = spawnSync("dovecote", args, { encoding: "utf8" });
  return {
    code: r.status ?? -1,
    stdout: (r.stdout as string) ?? "",
    stderr: (r.stderr as string) ?? "",
  };
}

// ---------- instance id validation ----------

const INSTANCE_ID_REGEX = /^[a-z0-9][a-z0-9-]*$/;

function validateInstanceId(id: string): string | null {
  if (!INSTANCE_ID_REGEX.test(id)) return "must match [a-z0-9][a-z0-9-]*";
  if (id.endsWith("-")) return "must not end with a dash";
  if (id.includes("--")) return "must not contain consecutive dashes";
  return null;
}

// ---------- list existing instances via the deployed worker ----------

interface ExistingInstance {
  service: "telegram" | "discord";
  instanceId: string;
  channelId: string;
}

function listExisting(service: "telegram" | "discord"): ExistingInstance[] {
  // We use `dovecote channels list` so that we hit the worker the operator
  // is currently configured against (their CLI config picks the env). This
  // is more accurate than re-parsing the secret JSON (which we can't read
  // back from CF anyway).
  const r = dovecote(["channels", "list"]);
  if (r.code !== 0) {
    warn(
      `dovecote channels list failed (exit=${r.code}). Falling back to empty list.\n` +
        `  Make sure your CLI is pointed at the ${envName} worker (check ~/.config/dovecote/config.json).`
    );
    return [];
  }
  const out: ExistingInstance[] = [];
  for (const line of r.stdout.split("\n")) {
    // Format: `Display (instance) | <service>-<instance>`
    const m = line.match(/\|\s*(telegram|discord)-([a-z0-9][a-z0-9-]*)$/i);
    if (m && m[1] && m[2]) {
      const svc = m[1].toLowerCase() as "telegram" | "discord";
      if (svc === service) {
        out.push({ service: svc, instanceId: m[2], channelId: `${svc}-${m[2]}` });
      }
    }
  }
  return out;
}

// ---------- assemble + push ----------

interface TelegramInstance {
  id: string;
  botToken: string;
  chatId: string;
}
interface DiscordInstance {
  id: string;
  webhookUrl: string;
}

async function gatherTelegramInstance(id: string, isNew: boolean): Promise<TelegramInstance> {
  const label = isNew ? "new" : "existing";
  info(`Telegram instance ${id} (${label}) — paste credentials:`);
  const botToken = await askSecret("    bot token:");
  if (!botToken) fail(`bot token required for ${id}`);
  const chatId = await ask("    chat id:");
  if (!chatId) fail(`chat id required for ${id}`);
  return { id, botToken, chatId };
}

async function gatherDiscordInstance(id: string, isNew: boolean): Promise<DiscordInstance> {
  const label = isNew ? "new" : "existing";
  info(`Discord instance ${id} (${label}) — paste credentials:`);
  const webhookUrl = await askSecret("    webhook url:");
  if (!webhookUrl) fail(`webhook url required for ${id}`);
  return { id, webhookUrl };
}

async function pushSecret(secretName: string, value: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "dovecote-channel-"));
  const file = join(dir, "channel.json");
  const payload: Record<string, string> = { [secretName]: value };
  writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
  try {
    const r = wrangler(["secret", "bulk", file, "--env", envName]);
    if (r.code !== 0) fail(`wrangler secret bulk failed for ${secretName}`);
    ok(`pushed ${secretName} (${value.length} chars)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- main ----------

async function main(): Promise<void> {
  stdout.write(
    `\ndovecote channel-add — target env: dovecote-${envName}\n` +
      `Existing instances are detected via 'dovecote channels list'. You'll be asked\n` +
      `to re-paste their credentials (CF doesn't expose secret values for read-back).\n\n`
  );

  const service = (await ask(
    "  Service to append to? [telegram / discord]",
    "telegram"
  )).toLowerCase();
  if (service !== "telegram" && service !== "discord") {
    fail(`unsupported service '${service}'`);
  }

  // 1. Detect existing instances on the worker for this service
  const existing = listExisting(service as "telegram" | "discord");
  if (existing.length === 0) {
    info(`no existing ${service} instances detected — this will be the first`);
  } else {
    info(`existing ${service} instances:`);
    for (const e of existing) {
      stdout.write(`      ${e.channelId}\n`);
    }
  }

  // 2. Prompt for the new instance id
  let newId = "";
  while (!newId) {
    const candidate = (
      await ask("  new instance id (e.g. release, alerts, team-frontend):")
    );
    const err = validateInstanceId(candidate);
    if (err) {
      warn(`invalid id '${candidate}': ${err}`);
      continue;
    }
    if (existing.some((e) => e.instanceId === candidate)) {
      warn(`'${candidate}' already exists — pick a different id`);
      continue;
    }
    newId = candidate;
  }

  // 3. Prompt re-paste for existing + gather new
  if (existing.length > 0) {
    info(
      `\nRe-paste credentials for the existing ${existing.length} ${service} ` +
        `instance(s). The values are NOT in your config.json — you need them from\n` +
        `  ~/.dovecote/secrets-${envName}.txt OR your password manager OR @BotFather / Discord settings.\n`
    );
    const proceed = await askYesNo("  Ready?", true);
    if (!proceed) fail("aborted by user");
  }

  // 4. Gather all instances + assemble JSON
  if (service === "telegram") {
    const all: TelegramInstance[] = [];
    for (const e of existing) all.push(await gatherTelegramInstance(e.instanceId, false));
    all.push(await gatherTelegramInstance(newId, true));
    await pushSecret("TELEGRAM_INSTANCES", JSON.stringify(all));
  } else {
    const all: DiscordInstance[] = [];
    for (const e of existing) all.push(await gatherDiscordInstance(e.instanceId, false));
    all.push(await gatherDiscordInstance(newId, true));
    await pushSecret("DISCORD_INSTANCES", JSON.stringify(all));
  }

  // 5. Verify
  const channelId = `${service}-${newId}`;
  info(`\nVerifying via 'dovecote channels list'...`);
  const after = listExisting(service as "telegram" | "discord");
  if (after.some((e) => e.instanceId === newId)) {
    ok(`new channel live: ${channelId}`);
    stdout.write(`\n  Try it:\n    dovecote notify ${channelId} --text "hello from ${newId}"\n\n`);
  } else {
    warn(
      `channel ${channelId} not yet visible — secrets propagate within ~5 seconds. ` +
        `Re-run 'dovecote channels list' shortly.`
    );
  }

  rl.close();
}

main().catch((e) => {
  stderr.write(`\n✘ channel-add crashed: ${(e as Error).stack || e}\n`);
  rl.close();
  exit(1);
});
