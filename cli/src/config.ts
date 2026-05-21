import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError, ExitCode } from "./exit-codes.ts";

/**
 * Shape of a single token entry recorded locally by `dovecote auth login`.
 */
export interface LocalToken {
  tokenId: string;
  token: string;
  userId: string;
  scopes: string[];
  expiresAt: number; // milliseconds since epoch (matches server)
  label?: string;
}

/**
 * On-disk config schema (single token for current operator).
 */
export interface CliConfig {
  serverUrl: string;
  clientVersion?: string;
  /**
   * Currently always 0 or 1 token. Stored as an array so `tokens list` can
   * iterate without special-casing.
   */
  tokens: LocalToken[];
}

/**
 * Resolve the XDG config path: `$XDG_CONFIG_HOME/dovecote/config.json` or
 * `$HOME/.config/dovecote/config.json`.
 */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "dovecote", "config.json");
}

/**
 * Read the config from disk. Returns null if no config file exists.
 * Throws on malformed JSON.
 */
export async function readConfig(path?: string): Promise<CliConfig | null> {
  const p = path ?? configPath();
  try {
    const text = await fs.readFile(p, "utf-8");
    const parsed = JSON.parse(text) as CliConfig;
    if (!parsed.tokens) parsed.tokens = [];
    // Backcompat guard: tokens written by older CLI versions lack `userId`.
    for (const t of parsed.tokens) {
      if (typeof (t as any).userId !== "string" || (t as any).userId.length === 0) {
        throw new CliError(
          ExitCode.NO_CONFIG,
          "config schema outdated; run `dovecote auth login` again"
        );
      }
    }
    return parsed;
  } catch (e: any) {
    if (e instanceof CliError) throw e;
    if (e && e.code === "ENOENT") return null;
    if (e instanceof SyntaxError) {
      throw new CliError(ExitCode.GENERIC, `Malformed config file at ${p}`);
    }
    throw e;
  }
}

/**
 * Write the config atomically: write to a tempfile, chmod 0600, then rename.
 * Ensures parent dir exists with mode 0700.
 */
export async function writeConfig(
  config: CliConfig,
  path?: string
): Promise<void> {
  const p = path ?? configPath();
  const dir = dirname(p);
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (e: any) {
    if (e && e.code === "EACCES") {
      throw new CliError(
        ExitCode.FS_WRITE,
        `Failed to create config dir: ${e.message}`
      );
    }
    throw e;
  }
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, p);
    // Force mode again after rename in case OS preserved less restrictive perms.
    await fs.chmod(p, 0o600);
  } catch (e: any) {
    try {
      await fs.unlink(tmp);
    } catch {
      // ignore cleanup failure
    }
    if (e && (e.code === "EACCES" || e.code === "EPERM")) {
      throw new CliError(
        ExitCode.FS_WRITE,
        `Failed to write config: ${e.code}`
      );
    }
    throw e;
  }
}

/**
 * Remove the config file. Idempotent — succeeds even if absent.
 */
export async function clearConfig(path?: string): Promise<void> {
  const p = path ?? configPath();
  try {
    await fs.unlink(p);
  } catch (e: any) {
    if (e && e.code === "ENOENT") return;
    throw e;
  }
}

/**
 * Resolve the active token to use for HTTP calls.
 *
 * Precedence:
 *   1. `DOVECOTE_TOKEN` env var (source: "env"; no auto-renew)
 *   2. tokens[0] in config (source: "config"; eligible for auto-renew)
 *   3. null → caller decides (e.g., login command can proceed without a token)
 */
export interface ActiveToken {
  token: string;
  /** Source dictates whether the HTTP client should attempt auto-renew. */
  source: "env" | "config";
  /** Present only for config-sourced tokens. */
  tokenId?: string;
  /** Present only for config-sourced tokens. */
  userId?: string;
  /** ms since epoch; undefined for env-sourced. */
  expiresAt?: number;
  scopes?: string[];
}

export function resolveActiveToken(
  config: CliConfig | null,
  env: NodeJS.ProcessEnv = process.env
): ActiveToken | null {
  const envTok = env.DOVECOTE_TOKEN;
  if (envTok) return { token: envTok, source: "env" };
  if (config && config.tokens.length > 0) {
    const t = config.tokens[0]!;
    return {
      token: t.token,
      source: "config",
      tokenId: t.tokenId,
      userId: t.userId,
      expiresAt: t.expiresAt,
      scopes: t.scopes,
    };
  }
  return null;
}

/**
 * Resolve the active server URL: env `DOVECOTE_SERVER_URL` > config.serverUrl > default.
 */
export const DEFAULT_SERVER_URL = "https://dovecote.example.com";

export function resolveServerUrl(
  config: CliConfig | null,
  env: NodeJS.ProcessEnv = process.env
): string {
  return env.DOVECOTE_SERVER_URL ?? config?.serverUrl ?? DEFAULT_SERVER_URL;
}
