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
  // Use --json mode to get the channel id field reliably. Previous text-mode
  // parsing matched a regex against the human-readable output, which didn't
  // include the channel id (only `name | service`) -- the script silently
  // returned an empty list and the resulting `wrangler secret put` OVERWROTE
  // every existing instance with just the new one. JSON has the canonical
  // `{id, name, enabled, service}` shape from /v1/channels.
  //
  // Fail-fast on any error: a silent empty list here means a destructive
  // overwrite in step 4. Operator should investigate before retrying.
  const r = dovecote(["channels", "list", "--json"]);
  if (r.code !== 0) {
    fail(
      `dovecote channels list --json failed (exit=${r.code}).\n` +
        `  Make sure the CLI is pointed at the ${envName} worker (check ~/.config/dovecote/config.json).\n` +
        `  stderr: ${r.stderr.trim().slice(0, 200)}\n` +
        `  Aborting to avoid overwriting existing instances with an empty list.`
    );
  }
  let parsed: { channels?: Array<{ id?: string; service?: string }> };
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    fail(
      `dovecote channels list --json returned unparseable output (${(e as Error).message}). ` +
        `Aborting to avoid an overwrite.`
    );
  }
  const out: ExistingInstance[] = [];
  for (const ch of parsed.channels ?? []) {
    if (!ch.id || ch.service !== service) continue;
    // `id` looks like `<service>-<instance>`. Strip the leading `<service>-`.
    const prefix = `${service}-`;
    if (!ch.id.startsWith(prefix)) continue;
    const instanceId = ch.id.slice(prefix.length);
    out.push({ service, instanceId, channelId: ch.id });
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

// ---------- env-mismatch guard ----------

function assertCliPointsAtTargetEnv(): void {
  // The local CLI's serverUrl decides which worker we list channels from.
  // If it diverges from the env we're targeting (e.g. CLI on prod but
  // script invoked with --env staging), listExisting() would return the
  // wrong env's instances and a push would clobber the OTHER env.
  const stateFile = join(
    process.env.HOME ?? "",
    ".dovecote",
    `state-${envName}.json`
  );
  const cliConfig = join(
    process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config"),
    "dovecote",
    "config.json"
  );

  let stateUrl = "";
  let cliUrl = "";
  try {
    const s = JSON.parse(require("node:fs").readFileSync(stateFile, "utf8"));
    stateUrl = (s.serverUrl || "").replace(/\/+$/, "");
  } catch {
    // No state file — first run for this env. Skip the check, but warn.
    warn(
      `no ~/.dovecote/state-${envName}.json found; can't cross-check that the ` +
        `CLI is pointed at ${envName}. If the CLI is pointing elsewhere this ` +
        `script will read the WRONG env's channels and overwrite ${envName}.`
    );
    return;
  }
  try {
    const c = JSON.parse(require("node:fs").readFileSync(cliConfig, "utf8"));
    cliUrl = (c.serverUrl || "").replace(/\/+$/, "");
  } catch {
    fail(
      `CLI not configured: ~/.config/dovecote/config.json missing or unreadable. ` +
        `Run \`bun run setup -- --env ${envName} --resume\` first to mint a CLI token.`
    );
  }

  if (stateUrl && cliUrl && stateUrl !== cliUrl) {
    fail(
      `Env mismatch: this script is targeting ${envName} (${stateUrl}) but the ` +
        `local CLI is configured for a DIFFERENT server (${cliUrl}). ` +
        `Listing channels would return the wrong env and a push would overwrite ${envName}. ` +
        `Either switch the CLI (re-run \`bun run setup -- --env ${envName} --resume\`) ` +
        `or call this script with the env that matches the CLI.`
    );
  }
}

// ---------- main ----------

async function main(): Promise<void> {
  stdout.write(
    `\ndovecote channel-add — target env: dovecote-${envName}\n` +
      `Existing instances are detected via 'dovecote channels list'. You'll be asked\n` +
      `to re-paste their credentials (CF doesn't expose secret values for read-back).\n\n`
  );

  assertCliPointsAtTargetEnv();

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
