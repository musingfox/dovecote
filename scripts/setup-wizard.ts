#!/usr/bin/env bun
/**
 * dovecote setup wizard
 *
 * Interactive walkthrough for first-time deployment + user seeding +
 * OAuth-client bootstrap. Targets the staging or production env defined
 * in wrangler.toml. Each step prints what it's about to do and lets you
 * skip / re-run.
 *
 * Usage:
 *   bun run setup
 *   bun run setup -- --env staging   # default
 *   bun run setup -- --env production
 *   bun run setup -- --resume        # skip checks that are already satisfied
 */

import { randomBytes } from "node:crypto";
import { DEFAULT_SCOPES } from "./wizard-defaults.js";
import { makeWranglerKv } from "./lib/wrangler-kv.js";
import { issueToken, KVWriteError } from "../src/auth/api-token.js";
import type { Env } from "../src/types.js";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr, env, argv, exit } from "node:process";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  chmodSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir, homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
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
const resume = flag("resume", false) as boolean;

if (envName !== "staging" && envName !== "production") {
  stderr.write(`✘ --env must be 'staging' or 'production' (got: ${envName})\n`);
  exit(1);
}

// ---------- IO helpers ----------

const rl = createInterface({ input: stdin, output: stdout });

async function ask(prompt: string, def?: string): Promise<string> {
  const suffix = def !== undefined ? ` [${def}]` : "";
  const ans = await rl.question(`${prompt}${suffix} `);
  return ans.trim() || def || "";
}

async function askSecret(prompt: string): Promise<string> {
  // Best-effort: disable echo via raw mode on TTY; readline reveals it
  // anyway. Acceptable for a local wizard the user is driving themselves.
  const ans = await rl.question(`${prompt} `);
  return ans.trim();
}

async function askYesNo(prompt: string, def = true): Promise<boolean> {
  const tag = def ? "[Y/n]" : "[y/N]";
  const ans = (await rl.question(`${prompt} ${tag} `)).trim().toLowerCase();
  if (ans === "") return def;
  return ans === "y" || ans === "yes";
}

function header(n: number, total: number, title: string): void {
  stdout.write(`\n━━ [${n}/${total}] ${title} ━━\n`);
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

// ---------- state persistence ----------

function statePath(envName: string): string {
  return join(homedir(), ".dovecote", `state-${envName}.json`);
}

interface WizardState {
  envName: string;
  serverUrl?: string;
  username?: string;
  channelIds?: string[];
  lastUpdated?: string;
}

function loadState(envName: string): WizardState {
  const p = statePath(envName);
  if (!existsSync(p)) return { envName };
  try {
    return JSON.parse(readFileSync(p, "utf8")) as WizardState;
  } catch {
    return { envName };
  }
}

function saveState(envName: string, patch: Partial<WizardState>): void {
  const p = statePath(envName);
  mkdirSync(dirname(p), { recursive: true });
  const merged = {
    ...loadState(envName),
    ...patch,
    envName,
    lastUpdated: new Date().toISOString(),
  };
  writeFileSync(p, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
}

// ---------- wrangler shell helpers ----------

function wrangler(
  args: string[],
  opts: { capture?: boolean; stdin?: string } = {}
): { code: number; stdout: string; stderr: string } {
  const res = spawnSync("wrangler", args, {
    stdio: opts.capture
      ? ["pipe", "pipe", "pipe"]
      : ["inherit", "inherit", "inherit"],
    input: opts.stdin,
    encoding: "utf8",
  });
  return {
    code: res.status ?? -1,
    stdout: (res.stdout as string) ?? "",
    stderr: (res.stderr as string) ?? "",
  };
}

// ---------- secret generation ----------

function genSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64");
}

// ---------- step implementations ----------

async function step0_prereqs(): Promise<void> {
  header(0, 9, "Prerequisites");

  // bun
  const bun = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (bun.status !== 0) fail("`bun` not on PATH — install from https://bun.sh");
  const bunVer = (bun.stdout || "").trim();
  ok(`bun ${bunVer}`);

  // wrangler
  const wr = spawnSync("wrangler", ["--version"], { encoding: "utf8" });
  if (wr.status !== 0)
    fail("`wrangler` not on PATH — run `bun install` to get the dev dependency");
  // wrangler --version emits lines like "wrangler 4.40.2 (update available 4.94.0)"; grab first line
  const wrVer = ((wr.stdout || "").split("\n")[0] ?? "").trim();
  ok(wrVer);

  // jq (optional — only the verify-from-stdout path uses it)
  const jq = spawnSync("jq", ["--version"], { encoding: "utf8" });
  if (jq.status === 0) {
    ok(`jq ${(jq.stdout || "").trim()}`);
  } else {
    warn(
      "jq not on PATH — optional (for manual JSON parsing)"
    );
  }
}

async function step1_authCheck(): Promise<void> {
  header(1, 9, "Cloudflare authentication");
  const r = wrangler(["whoami"], { capture: true });
  if (r.code !== 0) {
    if (
      /CLOUDFLARE_API_TOKEN/.test(r.stderr) ||
      /not authenticated/i.test(r.stderr)
    ) {
      info(
        "wrangler is not authenticated. Two options:\n" +
          "    A) run `wrangler login` in another terminal (opens browser), then re-run this wizard.\n" +
          "    B) set CLOUDFLARE_API_TOKEN env var to a token with Workers + KV edit permissions."
      );
      fail("Authenticate wrangler and re-run.");
    }
    fail(`wrangler whoami failed: ${r.stderr.trim()}`);
  }
  const userLine = r.stdout
    .split("\n")
    .find((l) => /associated with the email|account id/i.test(l));
  ok(`wrangler authenticated${userLine ? ` (${userLine.trim()})` : ""}`);
}

interface SecretPlan {
  name: string;
  value: string;
  source: "generated" | "existing" | "user";
}

async function step2_secrets(): Promise<SecretPlan[]> {
  header(2, 9, `Generate + push secrets to dovecote (${envName})`);

  const existing = wrangler(["secret", "list", "--env", envName], {
    capture: true,
  });
  const existingNames = new Set<string>();
  if (existing.code === 0) {
    try {
      const parsed = JSON.parse(existing.stdout);
      if (Array.isArray(parsed)) {
        for (const row of parsed) {
          if (row && typeof row.name === "string") existingNames.add(row.name);
        }
      }
    } catch {
      // wrangler may emit non-JSON on older versions; ignore
    }
  }

  const required = [
    "HMAC_PEPPER",
    "ADMIN_REVOKE_TOKEN",
  ];

  const plan: SecretPlan[] = [];
  for (const name of required) {
    if (existingNames.has(name)) {
      if (resume) {
        info(`${name} already set — skipping (--resume)`);
        plan.push({ name, value: "", source: "existing" });
        continue;
      }
      const replace = await askYesNo(
        `  ${name} already exists on ${envName}. Replace?`,
        false
      );
      if (!replace) {
        plan.push({ name, value: "", source: "existing" });
        continue;
      }
    }
    const value = genSecret(32);
    plan.push({ name, value, source: "generated" });
    ok(`generated ${name} (32 random bytes, base64)`);
  }

  const toPush = plan.filter((p) => p.source === "generated");
  if (toPush.length === 0) {
    ok("nothing to push (all required secrets already present)");
    return plan;
  }

  // Persist generated secrets to a local file BEFORE pushing — if the wrangler
  // push fails, the user still has the values on disk to retry with.
  const secretsFile = join(homedir(), ".dovecote", `secrets-${envName}.txt`);
  mkdirSync(dirname(secretsFile), { recursive: true });
  const ts = new Date().toISOString();
  const lines = [
    `# dovecote ${envName} secrets — generated ${ts}`,
    `# IMPORTANT`,
    `#   1. Move these into your password manager (1Password / Bitwarden / etc.).`,
    `#   2. Delete this file after copying — it's plaintext on your disk.`,
    `#   3. HMAC_PEPPER is UNRECOVERABLE. Losing it invalidates every dvct_* token`,
    `#      ever issued by this worker; rotating it requires re-issuing all CLI tokens.`,
    ``,
  ];
  for (const p of toPush) lines.push(`${p.name}=${p.value}`);
  writeFileSync(secretsFile, lines.join("\n") + "\n", { mode: 0o600 });
  ok(`wrote ${secretsFile} (mode 0600) — copy to password manager, then delete`);

  info(`pushing ${toPush.length} secret(s) via wrangler secret bulk...`);
  const dir = mkdtempSync(join(tmpdir(), "dovecote-setup-"));
  const file = join(dir, "secrets.json");
  const payload: Record<string, string> = {};
  for (const p of toPush) payload[p.name] = p.value;
  writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });

  try {
    const r = wrangler(["secret", "bulk", file, "--env", envName]);
    if (r.code !== 0) fail("wrangler secret bulk failed");
    ok(`pushed ${toPush.length} secret(s) to ${envName}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return plan;
}

async function step3_channel(): Promise<string[]> {
  header(3, 9, "Configure at least one notification channel");
  const choice = (
    await ask(
      "  Channel? [telegram / discord / both / skip]",
      "telegram"
    )
  ).toLowerCase();

  const instances: { name: string; payload: string }[] = [];
  const channelIds: string[] = [];

  if (choice === "telegram" || choice === "both") {
    info(
      "Telegram setup: Talk to @BotFather → /newbot → copy token; message your bot once → call getUpdates → copy chat_id"
    );
    const id = (await ask("    instance id (label)", "ops")) || "ops";
    const botToken = await askSecret("    bot token:");
    const chatId = await ask("    chat id:");
    if (!botToken || !chatId) {
      warn("missing bot token or chat id — skipping telegram");
    } else {
      instances.push({
        name: "TELEGRAM_INSTANCES",
        payload: JSON.stringify([{ id, botToken, chatId }]),
      });
      channelIds.push(`telegram-${id}`);
    }
  }

  if (choice === "discord" || choice === "both") {
    info(
      "Discord setup: channel → integrations → webhook → copy URL"
    );
    const id = (await ask("    instance id (label)", "ops")) || "ops";
    const webhookUrl = await askSecret("    webhook url:");
    if (!webhookUrl) {
      warn("missing webhook url — skipping discord");
    } else {
      instances.push({
        name: "DISCORD_INSTANCES",
        payload: JSON.stringify([{ id, webhookUrl }]),
      });
      channelIds.push(`discord-${id}`);
    }
  }

  if (choice === "skip") {
    warn(
      "skipped channel config — `dovecote notify` will return no_channels until you set TELEGRAM_INSTANCES or DISCORD_INSTANCES."
    );
    return [];
  }

  if (instances.length === 0) {
    warn("no channel configured — you can re-run the wizard later.");
    return [];
  }

  const dir = mkdtempSync(join(tmpdir(), "dovecote-setup-"));
  const file = join(dir, "channels.json");
  const payload: Record<string, string> = {};
  for (const i of instances) payload[i.name] = i.payload;
  writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
  try {
    const r = wrangler(["secret", "bulk", file, "--env", envName]);
    if (r.code !== 0) fail("wrangler secret bulk failed for channels");
    for (const i of instances) ok(`pushed ${i.name} (${i.payload.length} chars)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  saveState(envName, { channelIds });
  return channelIds;
}

function normalizeServerUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  // Accept bare host (`dovecote-staging.<sub>.workers.dev`) by adding scheme.
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  // Strip trailing slash for consistency.
  if (s.endsWith("/")) s = s.slice(0, -1);
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

async function askUrl(prompt: string): Promise<string> {
  while (true) {
    const raw = await ask(prompt);
    const normalized = normalizeServerUrl(raw);
    if (normalized) return normalized;
    warn(`'${raw}' is not a valid URL. Example: https://dovecote-staging.<sub>.workers.dev`);
  }
}

async function step4_deploy(): Promise<string> {
  header(4, 9, `Deploy worker (dovecote-${envName})`);

  if (resume) {
    const prior = loadState(envName).serverUrl;
    if (prior) {
      ok(`reusing serverUrl from state: ${prior}`);
      info(
        `(delete ${statePath(envName)} if you want to re-deploy in --resume mode)`
      );
      return prior;
    }
  }

  const proceed = resume
    ? false
    : await askYesNo("  Run `wrangler deploy --env " + envName + "` now?");
  let serverUrl: string;
  if (!proceed) {
    serverUrl = await askUrl(
      "  Deployed worker URL (paste from CF dashboard):"
    );
    saveState(envName, { serverUrl });
    return serverUrl;
  }
  const r = wrangler(["deploy", "--env", envName], { capture: true });
  stdout.write(r.stdout);
  if (r.stderr) stderr.write(r.stderr);
  if (r.code !== 0) fail("wrangler deploy failed");

  const urlMatch = r.stdout.match(/https:\/\/[\w.-]+workers\.dev/);
  if (urlMatch) {
    ok(`deployed: ${urlMatch[0]}`);
    serverUrl = urlMatch[0];
    saveState(envName, { serverUrl });
    return serverUrl;
  }
  warn("could not auto-detect deployed URL from wrangler output.");
  serverUrl = await askUrl("  Paste the deployed worker URL:");
  saveState(envName, { serverUrl });
  return serverUrl;
}

interface SeedResult {
  username: string;
  pepper: string;
  scopes: string[];
}

async function step5_seedUser(secrets: SecretPlan[]): Promise<SeedResult> {
  header(5, 9, "Seed your first user (OIDC placeholder record — no password)");

  const pepperEntry = secrets.find((s) => s.name === "HMAC_PEPPER");
  let pepper = pepperEntry?.value || "";
  if (!pepper) {
    info(
      "HMAC_PEPPER already existed on the worker (or you skipped regeneration);"
    );
    info(
      "the wizard does not store it. Paste the value you currently have set"
    );
    info("on the worker (must match exactly):");
    pepper = await askSecret("    HMAC_PEPPER:");
    if (!pepper)
      fail(
        "HMAC_PEPPER is required to HMAC-hash the CLI token minted in the next step."
      );
  }

  const priorUsername = loadState(envName).username ?? "nick";
  const username = (await ask("  username", priorUsername)) || priorUsername;
  if (!/^[a-z0-9_-]{1,64}$/.test(username))
    fail("username must match [a-z0-9_-]{1,64}");

  const scopes =
    (
      await ask(
        "  scopes (comma-separated)",
        DEFAULT_SCOPES.join(",")
      )
    ) || DEFAULT_SCOPES.join(",");
  const scopeList = scopes
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const supported = new Set([
    "dovecote:notify",
    "dovecote:admin",
  ]);
  for (const s of scopeList)
    if (!supported.has(s)) fail(`unsupported scope: ${s}`);

  // M8: same shape as resolve-user.ts auto-provision — an `algo:"oidc"`
  // placeholder with empty password material. No password is asked or stored;
  // identity is carried by dvct tokens and OIDC subjects only.
  const record = {
    username,
    algo: "oidc",
    iterations: 0,
    salt: "",
    hash: "",
    scopes: scopeList,
    createdAt: new Date().toISOString(),
  };
  const json = JSON.stringify(record);

  // --remote is REQUIRED on wrangler 4.x: `kv key put` defaults to writing
  // the local miniflare cache (`.wrangler/state/...`), not the deployed
  // worker's KV. Without it, the user record may not be visible to the worker.
  const r = wrangler(
    ["kv", "key", "put", "--remote", "--binding", "OAUTH_KV", `user:${username}`, json, "--env", envName],
    { capture: true }
  );
  stdout.write(r.stdout);
  if (r.code !== 0) {
    stderr.write(r.stderr);
    fail("wrangler kv key put failed");
  }
  ok(`user:${username} written to OAUTH_KV (env=${envName})`);
  saveState(envName, { username });
  return { username, pepper, scopes: scopeList };
}

async function step6_bootstrap(
  serverUrl: string,
  username: string,
  pepper: string,
  scopes: string[]
): Promise<void> {
  header(6, 9, "Mint personal CLI token (local)");
  if (!pepper) {
    fail("HMAC_PEPPER missing for local mint — re-run step 5 and paste it.");
  }

  // WizardLocalTokenMint (M7): reuse the production issueToken over a
  // wrangler --remote KV adapter. HMAC + three-key layout stay single-sourced
  // in src/auth/api-token.ts — no local re-implementation to drift.
  const adapter = makeWranglerKv(
    envName,
    (args) => wrangler(args, { capture: true }),
    (key) => info(`writing ${key} (--remote)`)
  );
  const mintEnv = { OAUTH_KV: adapter, HMAC_PEPPER: pepper } as unknown as Env;

  let minted;
  try {
    minted = await issueToken(
      { userId: username, scopes, label: "setup-wizard" },
      mintEnv
    );
  } catch (e) {
    if (e instanceof KVWriteError) {
      fail(
        `local mint failed writing to KV: ${e.message}\n` +
          "  Fix wrangler auth/network and re-run the wizard with --resume; a fresh token will be minted."
      );
    }
    throw e;
  }
  const { token, tokenId, expiresAt } = minted;
  ok(`minted local token ${tokenId} for ${username} (dvct_*, scopes: ${scopes.join(", ")})`);

  // Write CLI config so `dovecote` can use it immediately
  const { homedir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { promises: fsp } = await import("node:fs");
  const cfgPath = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "dovecote", "config.json");
  const cfgDir = dirname(cfgPath);
  await fsp.mkdir(cfgDir, { recursive: true, mode: 0o700 });
  const cliCfg = {
    serverUrl,
    tokens: [
      { tokenId, token, userId: username, scopes, expiresAt, label: "setup-wizard" },
    ],
  };
  const tmp = `${cfgPath}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify(cliCfg, null, 2), { mode: 0o600 });
  await fsp.chmod(tmp, 0o600);
  await fsp.rename(tmp, cfgPath);
  await fsp.chmod(cfgPath, 0o600);
  ok(`Token minted locally and saved to ${cfgPath}`);
}

async function step7_summary(
  serverUrl: string,
  username: string,
  secrets: SecretPlan[]
): Promise<void> {
  header(7, 9, "Save credentials");
  stdout.write(
    "\n  Stash these in your password manager — only shown once:\n\n"
  );
  for (const s of secrets) {
    if (s.source === "generated") {
      stdout.write(`    ${s.name}=${s.value}\n`);
    }
  }
  stdout.write("\n  Shell exports to copy:\n");
  stdout.write(`    export DOVECOTE_SERVER_URL=${serverUrl}\n`);
  stdout.write("\n");
  await askYesNo("  Stored safely?", true);
}

async function step8_nextSteps(
  serverUrl: string,
  username: string
): Promise<void> {
  header(8, 9, "Next: install CLI + verify");
  stdout.write("\n  Local install (macOS arm64 example):\n");
  stdout.write(
    "    curl -L -o dovecote.tar.gz https://github.com/musingfox/dovecote/releases/download/cli-v0.1.0/dovecote-bun-darwin-arm64.tar.gz\n"
  );
  stdout.write("    tar -xzf dovecote.tar.gz && xattr -d com.apple.quarantine ./dovecote\n");
  stdout.write("    sudo mv dovecote /usr/local/bin/\n\n");
  stdout.write(
    "  Token already saved to ~/.config/dovecote/config.json.\n"
  );
  stdout.write(
    "  Run `dovecote ping` to verify, then `dovecote notify <channel> --text \"hello\"`.\n\n"
  );
  stdout.write(`    export DOVECOTE_SERVER_URL=${serverUrl}\n`);
  stdout.write("    dovecote ping\n");
  stdout.write("    dovecote notify ops --text \"hello from setup\"\n\n");
  stdout.write(`    # seeded user: ${username}\n`);
}

async function step9_verify(
  serverUrl: string,
  channelIds: string[] = []
): Promise<void> {
  header(9, 9, "Verify end-to-end");
  info("Running `bun run verify` against the new deployment...");
  const channelArg = channelIds[0] ? ["--", "--channel", channelIds[0]] : [];
  const r = spawnSync(
    "bun",
    ["scripts/verify.ts", ...channelArg],
    {
      stdio: "inherit",
      env: { ...env, DOVECOTE_SERVER_URL: serverUrl },
    }
  );
  if (r.status !== 0) {
    warn("verify reported failures — your setup may be incomplete. See above for hints.");
  } else {
    ok("all checks passed");
  }
}

// ---------- main ----------

async function main(): Promise<void> {
  stdout.write(
    `\ndovecote setup wizard — target env: dovecote-${envName}\n` +
      `Press Ctrl-C to abort at any point; secrets that have already been pushed will survive.\n`
  );

  await step0_prereqs();
  await step1_authCheck();
  const secrets = await step2_secrets();
  const channelIds = await step3_channel();
  const serverUrl = await step4_deploy();
  const seed = await step5_seedUser(secrets);
  await step6_bootstrap(serverUrl, seed.username, seed.pepper, seed.scopes);
  await step7_summary(serverUrl, seed.username, secrets);
  await step8_nextSteps(serverUrl, seed.username);
  await step9_verify(
    serverUrl,
    channelIds.length > 0 ? channelIds : loadState(envName).channelIds ?? []
  );

  rl.close();
  stdout.write("\n  ✓ setup complete\n");
}

main().catch((e) => {
  stderr.write(`\n✘ wizard failed: ${(e as Error).stack || e}\n`);
  rl.close();
  exit(1);
});
