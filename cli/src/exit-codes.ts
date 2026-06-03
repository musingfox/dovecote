/**
 * Standard CLI exit codes (per plan D-C, sec "Exit codes 0-10").
 *
 * 0  ok
 * 1  generic error
 * 2  usage / argv error (bad flags, missing required arguments)
 * 3  no local config (logged out)
 * 4  upstream resource not found (404) — includes "no TTY for browser" and channel-not-found
 * 5  OAuth flow declined / state mismatch / loopback timeout
 * 6  insufficient scope / 403
 * 7  upstream 5xx / network / unreachable
 * 8  local FS write error
 * 9  expired credential — 401 expired_token; user must re-login
 * 10 client behind minClientVersion
 */
export const ExitCode = {
  OK: 0,
  GENERIC: 1,
  USAGE: 2,
  NO_CONFIG: 3,
  NOT_FOUND: 4,
  OAUTH_FAILED: 5,
  FORBIDDEN: 6,
  UPSTREAM: 7,
  FS_WRITE: 8,
  TOKEN_EXPIRED: 9,
  CLIENT_BEHIND: 10,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * Typed error that carries a precise exit code. Top-level main() maps these
 * to process.exit() codes.
 */
export class CliError extends Error {
  constructor(public readonly code: ExitCodeValue, message: string) {
    super(message);
    this.name = "CliError";
  }
}
