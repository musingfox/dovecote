import { parseArgs } from "node:util";
import { CliError, ExitCode } from "./exit-codes.ts";

export interface ParsedCommand {
  command: string;
  subcommand?: string;
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
  globalFlags: GlobalFlags;
}

export interface GlobalFlags {
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  timeout?: number;
}

/**
 * Parse the global flags shared across all commands. They may appear anywhere
 * in the argv list. Returns the global flag values and the remaining argv with
 * those tokens removed.
 */
export function extractGlobalFlags(argv: string[]): {
  global: GlobalFlags;
  remaining: string[];
} {
  const remaining: string[] = [];
  const global: GlobalFlags = {
    json: false,
    quiet: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === "--json") {
      global.json = true;
    } else if (tok === "--quiet" || tok === "-q") {
      global.quiet = true;
    } else if (tok === "--verbose" || tok === "-v") {
      global.verbose = true;
    } else if (tok === "--timeout") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new CliError(ExitCode.USAGE, "--timeout requires a value");
      }
      const n = parseInt(v, 10);
      if (Number.isNaN(n) || n < 0) {
        throw new CliError(ExitCode.USAGE, "--timeout must be a non-negative integer");
      }
      global.timeout = n;
      i++;
    } else if (tok.startsWith("--timeout=")) {
      const v = tok.slice("--timeout=".length);
      const n = parseInt(v, 10);
      if (Number.isNaN(n) || n < 0) {
        throw new CliError(ExitCode.USAGE, "--timeout must be a non-negative integer");
      }
      global.timeout = n;
    } else {
      remaining.push(tok);
    }
  }
  return { global, remaining };
}

/**
 * Top-level dispatcher: looks at the first positional and routes to a command.
 * `parseCommandArgs` is used by individual command modules to parse their own
 * options + positionals.
 */
export function parseTopLevel(argv: string[]): {
  command: string;
  subcommand?: string;
  rest: string[];
  globalFlags: GlobalFlags;
} {
  const { global, remaining } = extractGlobalFlags(argv);
  if (remaining.length === 0) {
    return { command: "help", rest: [], globalFlags: global };
  }
  const command = remaining[0]!;
  // Two-word commands: auth, channels, tokens
  const TWO_WORD = new Set(["auth", "channels", "tokens"]);
  if (TWO_WORD.has(command) && remaining.length >= 2) {
    return {
      command,
      subcommand: remaining[1],
      rest: remaining.slice(2),
      globalFlags: global,
    };
  }
  return { command, rest: remaining.slice(1), globalFlags: global };
}

/**
 * Thin wrapper around node:util parseArgs with our default style.
 * Throws CliError(USAGE) on parser failure.
 */
export function parseCommandArgs<
  T extends Record<
    string,
    { type: "string" | "boolean"; short?: string; multiple?: boolean; default?: any }
  >,
>(
  argv: string[],
  options: T
): { values: Record<keyof T, any>; positionals: string[] } {
  try {
    const res = parseArgs({
      args: argv,
      options: options as any,
      allowPositionals: true,
      strict: true,
    });
    return { values: res.values as any, positionals: res.positionals };
  } catch (e) {
    throw new CliError(ExitCode.USAGE, (e as Error).message);
  }
}
