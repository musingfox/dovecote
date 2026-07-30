#!/usr/bin/env bun
/**
 * dovecote setup verifier
 *
 * Runs 5 read-only health checks against your current dovecote setup and
 * prints PASS/FAIL per step. Designed for the post-`bun run setup` smoke
 * test the runbook walks through manually. Doesn't bail on the first
 * failure — every check runs, then exits 1 if any failed.
 *
 * Usage:
 *   bun run verify
 *   bun run verify -- --server-url https://dovecote-staging....workers.dev
 *   bun run verify -- --channel telegram-ops    # also runs a notify probe
 *   bun run verify -- --json                    # machine-readable output
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { stdout, stderr, env, argv, exit } from "node:process";

// ---------- args ----------

const args = argv.slice(2);
function flag(name: string, def: string | boolean = ""): string | boolean {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return def;
  const next = args[idx + 1];
  if (next === undefined || next.startsWith("--")) return true;
  return next;
}

const cliServerUrl = (flag("server-url", "") as string).trim();
const channelArg = (flag("channel", "") as string).trim();
const jsonMode = flag("json", false) as boolean;

// ---------- result tracking ----------

interface CheckResult {
  id: string;
  title: string;
  status: "pass" | "fail" | "skip";
  details: string[];
  hints: string[];
}

const results: CheckResult[] = [];

function pass(id: string, title: string, details: string[] = []): CheckResult {
  const r: CheckResult = { id, title, status: "pass", details, hints: [] };
  results.push(r);
  return r;
}

function failR(
  id: string,
  title: string,
  details: string[],
  hints: string[] = []
): CheckResult {
  const r: CheckResult = { id, title, status: "fail", details, hints };
  results.push(r);
  return r;
}

function skip(
  id: string,
  title: string,
  details: string[] = []
): CheckResult {
  const r: CheckResult = { id, title, status: "skip", details, hints: [] };
  results.push(r);
  return r;
}

// ---------- helpers ----------

function which(bin: string): string | null {
  const r = spawnSync("command", ["-v", bin], { encoding: "utf8", shell: true });
  if (r.status === 0) return (r.stdout || "").trim() || null;
  return null;
}

function run(
  cmd: string,
  args: string[],
  opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {}
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: opts.timeout ?? 15_000,
    env: opts.env ?? env,
  });
  return {
    code: r.status ?? -1,
    stdout: (r.stdout as string) ?? "",
    stderr: (r.stderr as string) ?? "",
  };
}

function readConfig():
  | { path: string; data: Record<string, unknown>; mode: number }
  | null {
  const base = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  const p = join(base, "dovecote", "config.json");
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    const mode = statSync(p).mode & 0o777;
    return { path: p, data, mode };
  } catch (e) {
    return { path: p, data: { __parse_error: (e as Error).message }, mode: 0 };
  }
}

function stripTrailingSlash(u: string): string {
  return u.endsWith("/") ? u.slice(0, -1) : u;
}

// ---------- checks ----------

async function check1_cliInstalled(): Promise<void> {
  const path = which("dovecote");
  if (!path) {
    failR(
      "cli-installed",
      "CLI is on PATH",
      [`\`dovecote\` not found in PATH (\`PATH=${env.PATH ?? ""}\`)`],
      [
        "Download from https://github.com/musingfox/dovecote/releases/tag/cli-v0.1.0",
        "Extract → `sudo mv dovecote /usr/local/bin/`",
        platform() === "darwin"
          ? "macOS: `xattr -d com.apple.quarantine $(command -v dovecote)`"
          : "",
      ].filter(Boolean)
    );
    return;
  }
  const r = run("dovecote", ["--version"]);
  if (r.code !== 0) {
    failR("cli-installed", "CLI is on PATH", [
      `\`dovecote --version\` exit=${r.code}`,
      r.stderr.trim() || r.stdout.trim() || "(no output)",
    ]);
    return;
  }
  const version = r.stdout.trim();
  pass("cli-installed", "CLI is on PATH", [`path: ${path}`, `version: ${version}`]);
}

interface ServerCtx {
  serverUrl: string;
  source: "flag" | "env" | "config";
}

async function check2_serverUrl(): Promise<ServerCtx | null> {
  let url = "";
  let source: "flag" | "env" | "config" | null = null;

  if (cliServerUrl) {
    url = cliServerUrl;
    source = "flag";
  } else if (env.DOVECOTE_SERVER_URL) {
    url = env.DOVECOTE_SERVER_URL;
    source = "env";
  } else {
    const cfg = readConfig();
    const cfgUrl = (cfg?.data?.serverUrl ?? cfg?.data?.server_url) as
      | string
      | undefined;
    if (cfgUrl) {
      url = cfgUrl;
      source = "config";
    }
  }

  if (!url) {
    failR(
      "server-url",
      "DOVECOTE_SERVER_URL is set",
      ["No --server-url flag, no $DOVECOTE_SERVER_URL, no serverUrl in config.json"],
      [
        "`export DOVECOTE_SERVER_URL=https://dovecote-staging.<sub>.workers.dev`",
        "OR pass `--server-url <url>` to this verify command",
      ]
    );
    return null;
  }

  url = stripTrailingSlash(url);
  pass("server-url", "DOVECOTE_SERVER_URL is set", [
    `value: ${url}`,
    `source: ${source}`,
  ]);
  return { serverUrl: url, source: source as "flag" | "env" | "config" };
}

async function check3_healthEndpoint(ctx: ServerCtx | null): Promise<void> {
  if (!ctx) {
    skip("server-health", "Server /health responds OK");
    return;
  }
  try {
    const res = await fetch(`${ctx.serverUrl}/health`);
    const body = await res.text();
    if (!res.ok) {
      failR(
        "server-health",
        "Server /health responds OK",
        [`HTTP ${res.status} ${res.statusText}`, body.slice(0, 200)],
        [
          "Worker not deployed: `wrangler deployments list --name dovecote-staging`",
          "Or worker errored: `wrangler tail --env staging`",
        ]
      );
      return;
    }
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      failR("server-health", "Server /health responds OK", [
        "200 OK but body is not JSON",
        body.slice(0, 200),
      ]);
      return;
    }
    const status = (parsed.status as string) || "(missing)";
    const minClient = parsed.minClientVersion as string | undefined;
    pass("server-health", "Server /health responds OK", [
      `status: ${status}`,
      minClient ? `minClientVersion: ${minClient}` : "",
    ].filter(Boolean));
  } catch (e) {
    failR(
      "server-health",
      "Server /health responds OK",
      [`fetch failed: ${(e as Error).message}`],
      [
        "URL might be wrong (typo in `*.workers.dev` subdomain)",
        "Or DNS / network blocked",
      ]
    );
  }
}

interface TokenCtx {
  tokenId?: string;
  userId?: string;
  scopes?: string[];
  expiresAt?: number;
}

async function check4_loggedIn(): Promise<TokenCtx | null> {
  const cfg = readConfig();
  if (!cfg) {
    failR(
      "config-exists",
      "Logged in (config.json with token)",
      [
        `~/.config/dovecote/config.json does not exist (XDG_CONFIG_HOME=${env.XDG_CONFIG_HOME ?? "(unset)"})`,
      ],
      [
        "Run: `dovecote auth login --label \"$(hostname)\"`",
      ]
    );
    return null;
  }
  if (cfg.data.__parse_error) {
    failR("config-exists", "Logged in (config.json with token)", [
      `config exists at ${cfg.path} but failed to parse: ${cfg.data.__parse_error}`,
    ]);
    return null;
  }
  const tokens = (cfg.data.tokens ?? []) as Array<Record<string, unknown>>;
  const tokenStr = cfg.data.token as string | undefined;
  if (!tokens.length && !tokenStr) {
    failR(
      "config-exists",
      "Logged in (config.json with token)",
      [`config exists at ${cfg.path} but no token entries`],
      ["Run: `dovecote auth login`"]
    );
    return null;
  }
  const t = (tokens[0] ?? {}) as TokenCtx & Record<string, unknown>;
  const details = [`path: ${cfg.path}`, `mode: ${cfg.mode.toString(8)}`];
  if (t.tokenId) details.push(`tokenId: ${t.tokenId}`);
  if (t.userId) details.push(`userId: ${t.userId}`);
  if (t.scopes) details.push(`scopes: ${(t.scopes as string[]).join(",")}`);
  if (t.expiresAt) {
    const expIso = new Date((t.expiresAt as number) * 1000).toISOString();
    details.push(`expiresAt: ${expIso}`);
  }
  if (cfg.mode !== 0o600) {
    failR(
      "config-exists",
      "Logged in (config.json with token)",
      [...details, `expected mode 0600, got ${cfg.mode.toString(8)}`],
      [`chmod 600 ${cfg.path}`]
    );
    return null;
  }
  pass("config-exists", "Logged in (config.json with token)", details);
  return t as TokenCtx;
}

async function check5_ping(ctx: ServerCtx | null): Promise<void> {
  if (!ctx) {
    skip("dovecote-ping", "`dovecote ping` succeeds");
    return;
  }
  const cliPath = which("dovecote");
  if (!cliPath) {
    skip("dovecote-ping", "`dovecote ping` succeeds", [
      "CLI not on PATH (see check 1)",
    ]);
    return;
  }
  const r = run("dovecote", ["ping"], {
    env: { ...env, DOVECOTE_SERVER_URL: ctx.serverUrl },
  });
  if (r.code !== 0) {
    failR(
      "dovecote-ping",
      "`dovecote ping` succeeds",
      [`exit=${r.code}`, r.stdout.trim(), r.stderr.trim()].filter(Boolean),
      [
        r.stderr.includes("401") || r.stderr.includes("invalid_token")
          ? "Token expired or HMAC_PEPPER mismatch — re-run `dovecote auth login`"
          : "Run `wrangler tail --env staging` to see server-side error",
      ]
    );
    return;
  }
  pass("dovecote-ping", "`dovecote ping` succeeds", [r.stdout.trim()]);
}

async function check6_notify(ctx: ServerCtx | null): Promise<void> {
  if (!channelArg) {
    skip("notify-probe", "Notify probe", [
      "Pass --channel <id> (e.g. telegram-ops) to enable this check",
    ]);
    return;
  }
  if (!ctx) {
    skip("notify-probe", "Notify probe");
    return;
  }
  const cliPath = which("dovecote");
  if (!cliPath) {
    skip("notify-probe", "Notify probe", ["CLI not on PATH (see check 1)"]);
    return;
  }
  const text = `verify probe ${new Date().toISOString()}`;
  const r = run(
    "dovecote",
    ["notify", channelArg, "--text", text],
    {
      env: { ...env, DOVECOTE_SERVER_URL: ctx.serverUrl },
      timeout: 30_000,
    }
  );
  if (r.code !== 0) {
    failR(
      "notify-probe",
      `Notify probe (${channelArg})`,
      [`exit=${r.code}`, r.stdout.trim(), r.stderr.trim()].filter(Boolean),
      [
        r.stderr.includes("unknown_channel")
          ? "Run `dovecote channels list` to see valid channel ids"
          : r.stderr.includes("rate_limited")
            ? "Rate-limited (default 60/min/IP). Wait 60s and retry."
            : "Check `wrangler tail --env staging` for provider errors",
      ]
    );
    return;
  }
  pass("notify-probe", `Notify probe (${channelArg})`, [
    `text: "${text}"`,
    r.stdout.trim() || "(empty stdout — sent OK)",
    `↳ check your ${channelArg.split("-")[0]} chat for receipt`,
  ]);
}

// ---------- presenter ----------

function paint(): void {
  if (jsonMode) {
    stdout.write(JSON.stringify({ results }, null, 2) + "\n");
    return;
  }
  let passCount = 0;
  let failCount = 0;
  let skipCount = 0;
  stdout.write("\ndovecote verify — read-only health check\n");
  stdout.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  for (const r of results) {
    const tag =
      r.status === "pass" ? "✓ PASS" : r.status === "fail" ? "✘ FAIL" : "○ SKIP";
    stdout.write(`\n${tag}  ${r.title}\n`);
    for (const d of r.details) stdout.write(`        ${d}\n`);
    if (r.status === "fail") {
      for (const h of r.hints) stdout.write(`        → ${h}\n`);
    }
    if (r.status === "pass") passCount++;
    else if (r.status === "fail") failCount++;
    else skipCount++;
  }
  stdout.write(
    `\n${passCount} passed · ${failCount} failed · ${skipCount} skipped\n\n`
  );
}

// ---------- main ----------

async function main(): Promise<void> {
  await check1_cliInstalled();
  const ctx = await check2_serverUrl();
  await check3_healthEndpoint(ctx);
  await check4_loggedIn();
  await check5_ping(ctx);
  await check6_notify(ctx);

  paint();

  const anyFail = results.some((r) => r.status === "fail");
  exit(anyFail ? 1 : 0);
}

main().catch((e) => {
  stderr.write(`\n✘ verify crashed: ${(e as Error).stack || e}\n`);
  exit(2);
});
