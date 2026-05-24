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
  /** Injectable sleep for the device-flow poll loop (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for the device-flow poll loop. */
  now?: () => number;
}

export async function runAuthLogin(
  ctx: CmdCtx,
  deps: LoginDeps = {}
): Promise<number> {
  const { values } = parseCommandArgs(ctx.argv, {
    "client-id": { type: "string" },
    "server-url": { type: "string" },
    "no-browser": { type: "boolean" },
    "device": { type: "boolean" },
    "scope": { type: "string" },
    "expires-in": { type: "string" },
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

  // RFC 8628 device-code flow: NO browser, NO TTY required — the entire
  // point is to log in from headless / restricted environments. Branches off
  // BEFORE the TTY guard.
  if (values["device"]) {
    return runDeviceLogin(ctx, deps, {
      clientId,
      serverUrl,
      scope: values["scope"] as string | undefined,
      expiresIn: values["expires-in"] as string | undefined,
    });
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

interface DeviceLoginOpts {
  clientId: string;
  serverUrl: string;
  scope?: string;
  expiresIn?: string;
}

interface DeviceAuthorizeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

interface DeviceExchangeSuccess {
  token: string;
  tokenId: string;
  userId: string;
  scopes: string[];
  expiresAt: number;
  label?: string;
}

const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

async function runDeviceLogin(
  ctx: CmdCtx,
  deps: LoginDeps,
  opts: DeviceLoginOpts,
): Promise<number> {
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  // --- 1. Authorize ---
  const authBody: Record<string, unknown> = { client_id: opts.clientId };
  if (opts.scope) authBody.scope = opts.scope;
  if (opts.expiresIn) authBody.expiresIn = opts.expiresIn;

  const authRes = await fetchImpl(`${opts.serverUrl}/v1/auth/device-authorize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(authBody),
  });
  if (!authRes.ok) {
    let detail = `HTTP ${authRes.status}`;
    try {
      const e = (await authRes.json()) as any;
      if (e?.error) detail = e.error;
    } catch {
      // ignore body parse failures
    }
    throw new CliError(
      ExitCode.UPSTREAM,
      `device-authorize failed: ${detail}`,
    );
  }
  const auth = (await authRes.json()) as DeviceAuthorizeResponse;

  ctx.stdout(`Visit: ${auth.verification_uri}\n`);
  ctx.stdout(`Enter code: ${auth.user_code}\n`);
  ctx.stdout(`Expires in: ${auth.expires_in} seconds\n`);
  if (auth.verification_uri_complete) {
    ctx.stdout(`Direct link: ${auth.verification_uri_complete}\n`);
  }
  ctx.stdout(`Waiting for approval...\n`);

  // --- 2. Poll exchange-device ---
  let interval = Math.max(1, auth.interval);
  while (true) {
    await sleep(interval * 1000);

    const pollRes = await fetchImpl(
      `${opts.serverUrl}/v1/auth/exchange-device`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: DEVICE_GRANT_TYPE,
          device_code: auth.device_code,
        }),
      },
    );

    if (pollRes.status === 201) {
      const ok = (await pollRes.json()) as DeviceExchangeSuccess;
      if (typeof ok.userId !== "string" || ok.userId.length === 0) {
        throw new CliError(
          ExitCode.UPSTREAM,
          "Exchange response missing userId; server may be outdated",
        );
      }
      const newConfig: CliConfig = {
        serverUrl: opts.serverUrl,
        tokens: [
          {
            tokenId: ok.tokenId,
            token: ok.token,
            userId: ok.userId,
            scopes: ok.scopes,
            expiresAt: ok.expiresAt,
            ...(ok.label ? { label: ok.label } : {}),
          },
        ],
      };
      await writeConfig(newConfig, ctx.configPath ?? defaultConfigPath(ctx.env));
      ctx.stdout(
        `Logged in. tokenId=${ok.tokenId} scopes=[${ok.scopes.join(", ")}] expiresAt=${new Date(ok.expiresAt).toISOString()}\n`,
      );
      return ExitCode.OK;
    }

    if (pollRes.status === 429) {
      const retryAfter = pollRes.headers.get("Retry-After");
      const wait = retryAfter ? parseInt(retryAfter, 10) : interval;
      await sleep(Math.max(1, wait) * 1000);
      continue;
    }

    let body: any = {};
    try {
      body = await pollRes.json();
    } catch {
      // ignore body parse failures
    }
    const err = body?.error;

    if (err === "authorization_pending") {
      // Keep polling at current interval.
      continue;
    }
    if (err === "slow_down") {
      if (typeof body.interval === "number" && body.interval > interval) {
        interval = body.interval;
      } else {
        interval = Math.min(60, interval + 5);
      }
      continue;
    }
    if (err === "access_denied") {
      throw new CliError(ExitCode.OAUTH_FAILED, "user denied device approval");
    }
    if (err === "expired_token") {
      throw new CliError(ExitCode.OAUTH_FAILED, "device_code expired");
    }
    if (err === "misconfigured") {
      throw new CliError(
        ExitCode.UPSTREAM,
        "server is misconfigured (HMAC_PEPPER not set)",
      );
    }
    // Any other error → bubble as upstream failure.
    throw new CliError(
      ExitCode.UPSTREAM,
      `unexpected poll response: ${err ?? `HTTP ${pollRes.status}`}`,
    );
  }
}
