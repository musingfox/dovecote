import type { CmdCtx } from "../../main.ts";
import { CliError, ExitCode } from "../../exit-codes.ts";
import { parseCommandArgs } from "../../argv.ts";
import { readConfig, resolveServerUrl } from "../../config.ts";
import { createHttpClient } from "../../http.ts";
import { CLI_VERSION, compareVersions } from "../../version.ts";

export async function runAuthWhoami(ctx: CmdCtx): Promise<number> {
  const { values } = parseCommandArgs(ctx.argv, { json: { type: "boolean" } });
  const json = !!values.json || ctx.globalFlags.json;
  const config = await readConfig(ctx.configPath);
  if (!config || config.tokens.length === 0) {
    ctx.stderr("Not logged in\n");
    return ExitCode.NO_CONFIG;
  }
  const tok = config.tokens[0]!;
  const serverUrl = resolveServerUrl(config, ctx.env);

  const client = createHttpClient({
    serverUrl,
    config,
    env: ctx.env,
    fetchImpl: ctx.fetchImpl,
    now: ctx.now,
  });

  let healthBody: any = null;
  let healthOk = true;
  try {
    const res = await client.request({ path: "/health", noAuth: true });
    if (res.status >= 500) {
      healthOk = false;
    } else {
      healthBody = res.json<any>();
    }
  } catch (e) {
    if (e instanceof CliError) {
      healthOk = false;
    } else {
      healthOk = false;
    }
  }

  const minClientVersion = healthBody?.minClientVersion ?? null;
  const versionOk =
    minClientVersion === null ||
    compareVersions(CLI_VERSION, minClientVersion) >= 0;

  const result = {
    userId: tok.userId,
    scopes: tok.scopes,
    expiresAt: tok.expiresAt,
    serverUrl,
    serverVersion: minClientVersion,
    clientVersion: CLI_VERSION,
    versionOk,
  };

  if (json) {
    ctx.stdout(JSON.stringify(result, null, 2) + "\n");
  } else {
    ctx.stdout(
      `userId=${result.userId}\nscopes=${tok.scopes.join(",")}\nexpiresAt=${new Date(tok.expiresAt).toISOString()}\nserverUrl=${serverUrl}\nclientVersion=${CLI_VERSION}\nserverMinClientVersion=${minClientVersion ?? "unknown"}\n`
    );
  }
  if (!healthOk) {
    ctx.stderr("Server /health unreachable\n");
    return ExitCode.UPSTREAM;
  }
  if (!versionOk) {
    ctx.stderr(
      `Client version ${CLI_VERSION} is behind server's minClientVersion ${minClientVersion}\n`
    );
    return ExitCode.CLIENT_BEHIND;
  }
  return ExitCode.OK;
}
