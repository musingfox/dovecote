import type { CmdCtx } from "../../main.ts";
import { CliError, ExitCode } from "../../exit-codes.ts";
import { parseCommandArgs } from "../../argv.ts";
import {
  configPath as defaultConfigPath,
  readConfig,
  writeConfig,
  resolveServerUrl,
  type CliConfig,
} from "../../config.ts";
import {
  performLoopbackAuthorize,
  exchangeOAuthForRuntimeToken,
  type Browser,
  type LoopbackServerFactory,
} from "../../auth-flow.ts";

export interface LoginDeps {
  /** Browser opener — defaults to a no-op when --no-browser. */
  browser?: Browser;
  /** Loopback server factory (for tests). */
  loopbackFactory?: LoopbackServerFactory;
  /** TTY check override. */
  isTTY?: boolean;
  /** Override the OAuth callback timeout (ms). Production default is 120 000. */
  callbackTimeoutMs?: number;
}

const AUTH_LOGIN_HELP = `Usage: dovecote auth login [options]

Options:
  --client-id <id>     OAuth client id (defaults to DOVECOTE_CLIENT_ID env)
  --server-url <url>   Override server URL
  --no-browser         Print authorize URL instead of opening browser
  --label <string>     Label recorded on the runtime token (default: "dovecote-cli")
  --help, -h           Show this help
`;

export async function runAuthLogin(
  ctx: CmdCtx,
  deps: LoginDeps = {}
): Promise<number> {
  if (ctx.argv.includes("--help") || ctx.argv.includes("-h")) {
    ctx.stdout(AUTH_LOGIN_HELP);
    return ExitCode.OK;
  }

  const { values } = parseCommandArgs(ctx.argv, {
    "client-id": { type: "string" },
    "server-url": { type: "string" },
    "no-browser": { type: "boolean" },
    "label": { type: "string" },
  });

  const clientId =
    (values["client-id"] as string | undefined) ??
    ctx.env.DOVECOTE_CLIENT_ID;
  if (!clientId) {
    ctx.stderr(
      "Missing DOVECOTE_CLIENT_ID. Register a client via POST /admin/bootstrap-client and set DOVECOTE_CLIENT_ID.\n"
    );
    return ExitCode.USAGE;
  }

  // Tolerate outdated schema during login (the whole point is to refresh it).
  let existing: CliConfig | null = null;
  try {
    existing = await readConfig(ctx.configPath);
  } catch (e) {
    if (!(e instanceof CliError && e.code === ExitCode.NO_CONFIG)) throw e;
    // Stale schema → behave as if no config.
  }
  const serverUrl =
    (values["server-url"] as string | undefined) ??
    resolveServerUrl(existing, ctx.env);

  const noBrowser = !!values["no-browser"];
  const isTTY =
    deps.isTTY ?? (typeof process !== "undefined" && process.stdin.isTTY === true);
  if (!noBrowser && !isTTY) {
    ctx.stderr("No TTY; pass --no-browser to print the URL\n");
    return ExitCode.NOT_FOUND;
  }

  let oauthToken: string;
  try {
    oauthToken = await performLoopbackAuthorize({
      serverUrl,
      clientId,
      scopes: ["dovecote:admin", "dovecote:notify"],
      noBrowser,
      browser: deps.browser,
      loopbackFactory: deps.loopbackFactory,
      stderr: ctx.stderr,
      fetchImpl: ctx.fetchImpl,
      callbackTimeoutMs: deps.callbackTimeoutMs,
    });
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError(ExitCode.OAUTH_FAILED, (e as Error).message);
  }

  let exchange: {
    token: string;
    tokenId: string;
    userId: string;
    scopes: string[];
    expiresAt: number;
    label?: string;
  };
  const label = (values.label as string | undefined) ?? "dovecote-cli";
  try {
    exchange = await exchangeOAuthForRuntimeToken({
      serverUrl,
      oauthToken,
      label,
      fetchImpl: ctx.fetchImpl,
    });
  } catch (e) {
    if (e instanceof CliError) {
      if (e.code === ExitCode.GENERIC && e.message.startsWith("Exchange failed:")) {
        throw new CliError(ExitCode.UPSTREAM, e.message);
      }
      throw e;
    }
    throw new CliError(
      ExitCode.UPSTREAM,
      `Exchange failed: ${(e as Error).message}`
    );
  }

  if (typeof exchange.userId !== "string" || exchange.userId.length === 0) {
    throw new CliError(
      ExitCode.UPSTREAM,
      "Exchange response missing userId; server may be outdated"
    );
  }
  const newConfig: CliConfig = {
    serverUrl,
    tokens: [
      {
        tokenId: exchange.tokenId,
        token: exchange.token,
        userId: exchange.userId,
        scopes: exchange.scopes,
        expiresAt: exchange.expiresAt,
        ...(exchange.label ? { label: exchange.label } : {}),
      },
    ],
  };
  await writeConfig(newConfig, ctx.configPath ?? defaultConfigPath(ctx.env));

  ctx.stdout(
    `Logged in. tokenId=${exchange.tokenId} scopes=[${exchange.scopes.join(", ")}] expiresAt=${new Date(exchange.expiresAt).toISOString()} label='${exchange.label ?? label}'\n`
  );
  return ExitCode.OK;
}


