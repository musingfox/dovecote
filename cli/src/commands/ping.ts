import type { CmdCtx } from "../main.ts";
import { CliError, ExitCode } from "../exit-codes.ts";
import { parseCommandArgs } from "../argv.ts";
import { readConfig, resolveServerUrl } from "../config.ts";
import { createHttpClient } from "../http.ts";
import { CLI_VERSION, compareVersions } from "../version.ts";

export async function runPing(ctx: CmdCtx): Promise<number> {
  const { values } = parseCommandArgs(ctx.argv, {
    "server-url": { type: "string" },
  });
  const config = await readConfig(ctx.configPath);
  const serverUrl =
    (values["server-url"] as string | undefined) ??
    resolveServerUrl(config, ctx.env);

  const client = createHttpClient({
    serverUrl,
    config,
    env: ctx.env,
    fetchImpl: ctx.fetchImpl,
    now: ctx.now,
  });

  let body: any;
  try {
    const res = await client.request({ path: "/health", noAuth: true });
    if (res.status >= 500) {
      ctx.stderr(`Server unreachable: HTTP ${res.status}\n`);
      return ExitCode.UPSTREAM;
    }
    body = res.json<any>();
  } catch (e) {
    if (e instanceof CliError) {
      ctx.stderr(`Server unreachable: ${e.message}\n`);
      return e.code;
    }
    ctx.stderr(`Server unreachable: ${(e as Error).message}\n`);
    return ExitCode.UPSTREAM;
  }

  const minClientVersion = body.minClientVersion ?? "0.0.0";
  const ok = compareVersions(CLI_VERSION, minClientVersion) >= 0;
  ctx.stdout(
    `OK: ${serverUrl} (server v${minClientVersion}, client v${CLI_VERSION})\n`
  );
  if (!ok) {
    ctx.stderr(
      `Client version ${CLI_VERSION} is behind server's minClientVersion ${minClientVersion}\n`
    );
    return ExitCode.CLIENT_BEHIND;
  }
  return ExitCode.OK;
}
