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

import { randomBytes, pbkdf2Sync } from "node:crypto";
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

async function step1_authCheck(): Promise<void> {
  header(1, 8, "Cloudflare authentication");
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
  header(2, 8, `Generate + push secrets to dovecote (${envName})`);

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
    "COOKIE_ENCRYPTION_KEY",
    "HMAC_PEPPER",
    "ADMIN_REVOKE_TOKEN",
    "OAUTH_PASSWORD",
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
    ok("nothing to push (all 4 secrets already present)");
    return plan;
  }

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

async function step3_channel(): Promise<void> {
  header(3, 8, "Configure at least one notification channel");
  const choice = (
    await ask(
      "  Channel? [telegram / discord / both / skip]",
      "telegram"
    )
  ).toLowerCase();

  const instances: { name: string; payload: string }[] = [];

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
    }
  }

  if (choice === "skip") {
    warn(
      "skipped channel config — `dovecote notify` will return no_channels until you set TELEGRAM_INSTANCES or DISCORD_INSTANCES."
    );
    return;
  }

  if (instances.length === 0) {
    warn("no channel configured — you can re-run the wizard later.");
    return;
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
}

async function step4_deploy(): Promise<string> {
  header(4, 8, `Deploy worker (dovecote-${envName})`);
  const proceed = resume
    ? false
    : await askYesNo("  Run `wrangler deploy --env " + envName + "` now?");
  if (!proceed) {
    const url = await ask("  Deployed worker URL (paste from CF dashboard):");
    if (!url) fail("Need the deployed URL to continue.");
    return url;
  }
  const r = wrangler(["deploy", "--env", envName], { capture: true });
  stdout.write(r.stdout);
  if (r.stderr) stderr.write(r.stderr);
  if (r.code !== 0) fail("wrangler deploy failed");

  const urlMatch = r.stdout.match(/https:\/\/[\w.-]+workers\.dev/);
  if (urlMatch) {
    ok(`deployed: ${urlMatch[0]}`);
    return urlMatch[0];
  }
  warn("could not auto-detect deployed URL from wrangler output.");
  const url = await ask("  Paste the deployed worker URL:");
  if (!url) fail("Need the deployed URL to continue.");
  return url;
}

interface SeedResult {
  username: string;
  pepper: string;
}

async function step5_seedUser(secrets: SecretPlan[]): Promise<SeedResult> {
  header(5, 8, "Seed your first user");

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
        "HMAC_PEPPER is required to compute the byte-identical PBKDF2 record."
      );
  }

  const username = (await ask("  username", "nick")) || "nick";
  if (!/^[a-z0-9_-]{1,64}$/.test(username))
    fail("username must match [a-z0-9_-]{1,64}");

  const password = await askSecret("  password:");
  if (!password) fail("password required");

  const scopes =
    (
      await ask(
        "  scopes (comma-separated)",
        "dovecote:notify,dovecote:admin,dovecote:env:read"
      )
    ) || "dovecote:notify,dovecote:admin,dovecote:env:read";
  const scopeList = scopes
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const supported = new Set([
    "dovecote:notify",
    "dovecote:env:read",
    "dovecote:admin",
  ]);
  for (const s of scopeList)
    if (!supported.has(s)) fail(`unsupported scope: ${s}`);

  // Mirror seed-user.mjs exactly
  const salt = randomBytes(16);
  const hashBuf = pbkdf2Sync(password, salt, 100_000, 32, "sha256");
  const record = {
    username,
    algo: "pbkdf2-sha256",
    iterations: 100_000,
    salt: salt.toString("base64"),
    hash: hashBuf.toString("base64"),
    scopes: scopeList,
    createdAt: new Date().toISOString(),
  };
  const json = JSON.stringify(record);

  const r = wrangler(
    ["kv", "key", "put", "--binding", "OAUTH_KV", `user:${username}`, json, "--env", envName],
    { capture: true }
  );
  stdout.write(r.stdout);
  if (r.code !== 0) {
    stderr.write(r.stderr);
    fail("wrangler kv key put failed");
  }
  ok(`user:${username} written to OAUTH_KV (env=${envName})`);
  return { username, pepper };
}

async function step6_bootstrap(
  serverUrl: string,
  secrets: SecretPlan[]
): Promise<string> {
  header(6, 8, "Bootstrap an OAuth client");

  const adminEntry = secrets.find((s) => s.name === "ADMIN_REVOKE_TOKEN");
  let adminToken = adminEntry?.value || "";
  if (!adminToken) {
    info(
      "ADMIN_REVOKE_TOKEN was already set; paste the existing value to call /admin/bootstrap-client."
    );
    adminToken = await askSecret("    ADMIN_REVOKE_TOKEN:");
    if (!adminToken) fail("ADMIN_REVOKE_TOKEN required.");
  }

  const clientName = (await ask("  client name", "my-cli")) || "my-cli";
  const redirectInput = (
    await ask(
      "  redirect URI (loopback or https)",
      "http://127.0.0.1:9999/cb"
    )
  ) || "http://127.0.0.1:9999/cb";

  info("Temporarily enabling ENABLE_CLIENT_BOOTSTRAP...");
  const enable = wrangler(
    ["secret", "put", "ENABLE_CLIENT_BOOTSTRAP", "--env", envName],
    { stdin: "1\n" }
  );
  if (enable.code !== 0) fail("failed to enable client bootstrap");
  ok("ENABLE_CLIENT_BOOTSTRAP=1 set");

  info("Calling POST /admin/bootstrap-client...");
  let clientId = "";
  try {
    const res = await fetch(`${serverUrl}/admin/bootstrap-client`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        clientName,
        redirectUris: [redirectInput],
      }),
    });
    const body = await res.text();
    if (!res.ok) {
      stderr.write(`  ✘ HTTP ${res.status}: ${body}\n`);
    } else {
      try {
        const parsed = JSON.parse(body);
        clientId = parsed.client_id || parsed.clientId || "";
        if (clientId) ok(`client_id: ${clientId}`);
        else warn(`unexpected response: ${body}`);
      } catch {
        warn(`non-JSON response: ${body}`);
      }
    }
  } catch (e) {
    stderr.write(`  ✘ fetch failed: ${(e as Error).message}\n`);
  }

  info("Disabling ENABLE_CLIENT_BOOTSTRAP...");
  const disable = wrangler(
    ["secret", "delete", "ENABLE_CLIENT_BOOTSTRAP", "--env", envName],
    { stdin: "y\n" }
  );
  if (disable.code !== 0) {
    warn(
      "failed to delete ENABLE_CLIENT_BOOTSTRAP — re-run `wrangler secret delete ENABLE_CLIENT_BOOTSTRAP --env " +
        envName +
        "` manually."
    );
  } else {
    ok("ENABLE_CLIENT_BOOTSTRAP removed");
  }

  return clientId;
}

async function step7_summary(
  serverUrl: string,
  username: string,
  clientId: string,
  secrets: SecretPlan[]
): Promise<void> {
  header(7, 8, "Save credentials");
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
  if (clientId) stdout.write(`    export DOVECOTE_CLIENT_ID=${clientId}\n`);
  stdout.write("\n");
  await askYesNo("  Stored safely?", true);
}

async function step8_nextSteps(
  serverUrl: string,
  username: string,
  clientId: string
): Promise<void> {
  header(8, 8, "Next: install CLI + log in");
  stdout.write("\n  Local install (macOS arm64 example):\n");
  stdout.write(
    "    curl -L -o dovecote.tar.gz https://github.com/musingfox/dovecote/releases/download/cli-v0.1.0/dovecote-bun-darwin-arm64.tar.gz\n"
  );
  stdout.write("    tar -xzf dovecote.tar.gz && xattr -d com.apple.quarantine ./dovecote\n");
  stdout.write("    sudo mv dovecote /usr/local/bin/\n\n");
  stdout.write("  Then log in:\n");
  stdout.write(`    export DOVECOTE_SERVER_URL=${serverUrl}\n`);
  if (clientId) stdout.write(`    export DOVECOTE_CLIENT_ID=${clientId}\n`);
  stdout.write(
    `    dovecote auth login --server-url ${serverUrl} --label "$(hostname)"\n`
  );
  stdout.write(`    # username: ${username}, password: (the one you set)\n\n`);
  stdout.write("  Smoke test:\n");
  stdout.write("    dovecote ping\n");
  stdout.write("    dovecote notify ops --text \"hello from setup\"\n\n");
}

// ---------- main ----------

async function main(): Promise<void> {
  stdout.write(
    `\ndovecote setup wizard — target env: dovecote-${envName}\n` +
      `Press Ctrl-C to abort at any point; secrets that have already been pushed will survive.\n`
  );

  await step1_authCheck();
  const secrets = await step2_secrets();
  await step3_channel();
  const serverUrl = await step4_deploy();
  const seed = await step5_seedUser(secrets);
  const clientId = await step6_bootstrap(serverUrl, secrets);
  await step7_summary(serverUrl, seed.username, clientId, secrets);
  await step8_nextSteps(serverUrl, seed.username, clientId);

  rl.close();
  stdout.write("\n  ✓ setup complete\n");
}

main().catch((e) => {
  stderr.write(`\n✘ wizard failed: ${(e as Error).stack || e}\n`);
  rl.close();
  exit(1);
});
