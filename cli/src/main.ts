import { parseTopLevel } from "./argv.ts";
import { CliError, ExitCode } from "./exit-codes.ts";
import { CLI_VERSION } from "./version.ts";

import { runAuthLogin } from "./commands/auth/login.ts";
import { runAuthLogout } from "./commands/auth/logout.ts";
import { runAuthWhoami } from "./commands/auth/whoami.ts";
import { runNotify } from "./commands/notify.ts";
import { runPing } from "./commands/ping.ts";
import { runChannelsList } from "./commands/channels/list.ts";
import { runChannelsTest } from "./commands/channels/test.ts";
import { runEnvGet } from "./commands/env/get.ts";
import { runTokensCreate } from "./commands/tokens/create.ts";
import { runTokensList } from "./commands/tokens/list.ts";
import { runTokensRevoke } from "./commands/tokens/revoke.ts";

export interface MainDeps {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** Override the default config path (for tests). */
  configPath?: string;
  /** Inject a fetch implementation (for tests). */
  fetchImpl?: typeof fetch;
  /** Inject Date.now (for tests). */
  now?: () => number;
}

const HELP_TEXT = `dovecote ${CLI_VERSION}

Usage: dovecote <command> [options]

Commands:
  auth login          Begin OAuth + exchange to acquire a runtime token
  auth logout         Revoke the local token and clear config
  auth whoami         Show current identity and server reachability
  notify <channel>    Send a notification (--text|--stdin|--embed-json)
  channels list       List configured channels
  channels test <ch>  Send a probe message to a channel
  env get <profile>   Read an env profile from the server
  tokens create       Mint a new dvct_* token
  tokens list         Show locally-stored tokens
  tokens revoke <id>  Revoke a token by id
  ping                Probe server reachability + version

Global flags:
  --json              JSON output
  --quiet, -q         Suppress non-error stderr
  --verbose, -v       Verbose stderr
  --timeout <ms>      Override default 30s timeout
`;

/**
 * Run the CLI. Returns the intended exit code. Does NOT call process.exit so
 * tests can drive it directly.
 */
export async function runMain(deps: MainDeps): Promise<number> {
  const stdout = deps.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = deps.stderr ?? ((s: string) => process.stderr.write(s));

  let parsed: ReturnType<typeof parseTopLevel>;
  try {
    parsed = parseTopLevel(deps.argv);
  } catch (e) {
    if (e instanceof CliError) {
      stderr(`Error: ${e.message}\n`);
      return e.code;
    }
    throw e;
  }
  const { command, subcommand, rest, globalFlags } = parsed;

  if (command === "help" || command === "--help" || command === "-h") {
    stdout(HELP_TEXT);
    return ExitCode.OK;
  }
  if (command === "--version" || command === "version") {
    stdout(`${CLI_VERSION}\n`);
    return ExitCode.OK;
  }

  const ctx = {
    argv: rest,
    globalFlags,
    env: deps.env ?? process.env,
    stdout,
    stderr,
    configPath: deps.configPath,
    fetchImpl: deps.fetchImpl,
    now: deps.now,
  };

  try {
    switch (command) {
      case "auth":
        if (subcommand === "login") return await runAuthLogin(ctx);
        if (subcommand === "logout") return await runAuthLogout(ctx);
        if (subcommand === "whoami") return await runAuthWhoami(ctx);
        stderr(`Unknown auth subcommand: ${subcommand ?? "(none)"}\n`);
        return ExitCode.USAGE;
      case "notify":
        return await runNotify(ctx);
      case "ping":
        return await runPing(ctx);
      case "channels":
        if (subcommand === "list") return await runChannelsList(ctx);
        if (subcommand === "test") return await runChannelsTest(ctx);
        stderr(`Unknown channels subcommand: ${subcommand ?? "(none)"}\n`);
        return ExitCode.USAGE;
      case "env":
        if (subcommand === "get") return await runEnvGet(ctx);
        stderr(`Unknown env subcommand: ${subcommand ?? "(none)"}\n`);
        return ExitCode.USAGE;
      case "tokens":
        if (subcommand === "create") return await runTokensCreate(ctx);
        if (subcommand === "list") return await runTokensList(ctx);
        if (subcommand === "revoke") return await runTokensRevoke(ctx);
        stderr(`Unknown tokens subcommand: ${subcommand ?? "(none)"}\n`);
        return ExitCode.USAGE;
      default:
        stderr(`Unknown command: ${command}\n${HELP_TEXT}`);
        return ExitCode.USAGE;
    }
  } catch (e) {
    if (e instanceof CliError) {
      stderr(`Error: ${e.message}\n`);
      return e.code;
    }
    stderr(`Unexpected error: ${(e as Error).message ?? e}\n`);
    return ExitCode.GENERIC;
  }
}

export interface CmdCtx {
  argv: string[];
  globalFlags: import("./argv.ts").GlobalFlags;
  env: NodeJS.ProcessEnv;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  configPath?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

// (Standalone entry has moved to cli/src/cli.ts; importing this module does NOT
//  execute runMain. The compiled binary is built from cli/src/cli.ts.)
