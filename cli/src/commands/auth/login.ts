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
  /** Injectable reader for pasted token on --token (defaults to process.stdin). Used by tests. */
  readStdin?: () => Promise<string>;
}

const AUTH_LOGIN_HELP = `Usage: dovecote auth login [options]

Options:
  --client-id <id>     OAuth client id (defaults to DOVECOTE_CLIENT_ID env)
  --server-url <url>   Override server URL
  --no-browser         Print authorize URL instead of opening browser
  --token              Read dvct_* token from stdin (pasted / headless / CI)
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
    "token": { type: "boolean" },
    "label": { type: "string" },
  });

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

  if (values["token"]) {
    return runTokenLogin(ctx, deps, { serverUrl });
  }

  const clientId =
    (values["client-id"] as string | undefined) ??
    ctx.env.DOVECOTE_CLIENT_ID;
  if (!clientId) {
    ctx.stderr(
      "Missing DOVECOTE_CLIENT_ID. Register a client via POST /admin/bootstrap-client and set DOVECOTE_CLIENT_ID.\n"
    );
    return ExitCode.USAGE;
  }

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

interface TokenLoginOpts {
  serverUrl: string;
}

async function runTokenLogin(
  ctx: CmdCtx,
  deps: LoginDeps,
  opts: TokenLoginOpts,
): Promise<number> {
  const raw = await (deps.readStdin ?? (async () => {
    let data = "";
    return new Promise<string>((resolve) => {
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", (chunk: string) => (data += chunk));
      process.stdin.on("end", () => resolve(data));
    });
  }))();
  const token = (raw || "").trim();
  if (!token) {
    ctx.stderr("no token provided\n");
    return ExitCode.USAGE;
  }
  if (!token.startsWith("dvct_")) {
    return ExitCode.USAGE;
  }

  const fetchImpl = ctx.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${opts.serverUrl}/v1/auth/whoami`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    // Network/DNS failure — upstream unreachable, not an auth failure.
    throw new CliError(ExitCode.UPSTREAM, `whoami request failed: ${(e as Error).message}`);
  }

  if (res.status === 401) {
    throw new CliError(ExitCode.OAUTH_FAILED, "token rejected (invalid or expired)");
  }
  if (!res.ok) {
    // Other non-2xx (5xx, 404, …) — the server misbehaved, map to UPSTREAM.
    throw new CliError(ExitCode.UPSTREAM, `whoami failed: HTTP ${res.status}`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new CliError(ExitCode.UPSTREAM, "whoami response not JSON");
  }

  const b = (body && typeof body === "object") ? (body as Record<string, unknown>) : {};
  const userId = typeof b.userId === "string" ? b.userId : undefined;
  const tokenId = typeof b.tokenId === "string" ? b.tokenId : undefined;
  const scopesRaw = b.scopes;
  const scopes = Array.isArray(scopesRaw) ? (scopesRaw as string[]) : [];
  const expiresAt = typeof b.expiresAt === "number" ? b.expiresAt : 0;
  if (typeof userId !== "string" || typeof tokenId !== "string" || !userId || !tokenId) {
    throw new CliError(ExitCode.UPSTREAM, "whoami response missing userId/tokenId");
  }

  const newConfig: CliConfig = {
    serverUrl: opts.serverUrl,
    tokens: [
      {
        tokenId,
        token,
        userId,
        scopes,
        expiresAt,
      },
    ],
  };
  await writeConfig(newConfig, ctx.configPath ?? defaultConfigPath(ctx.env));

  ctx.stdout(`Logged in. tokenId=${tokenId} scopes=[${scopes.join(", ")}] expiresAt=${new Date(expiresAt).toISOString()}\n`);
  return ExitCode.OK;
}
