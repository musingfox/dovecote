import type { CmdCtx } from "../../main.ts";
import { CliError, ExitCode } from "../../exit-codes.ts";
import { parseCommandArgs } from "../../argv.ts";
import { readConfig, resolveServerUrl } from "../../config.ts";
import { createHttpClient } from "../../http.ts";

export async function runChannelsList(ctx: CmdCtx): Promise<number> {
  const { values } = parseCommandArgs(ctx.argv, { json: { type: "boolean" } });
  const json = !!values.json || ctx.globalFlags.json;
  const config = await readConfig(ctx.configPath);
  const serverUrl = resolveServerUrl(config, ctx.env);
  const client = createHttpClient({
    serverUrl,
    config,
    env: ctx.env,
    fetchImpl: ctx.fetchImpl,
    now: ctx.now,
    configPath: ctx.configPath,
  });

  let res;
  try {
    res = await client.request({ method: "GET", path: "/v1/channels" });
  } catch (e) {
    if (e instanceof CliError) {
      ctx.stderr(`${e.message}\n`);
      return e.code;
    }
    ctx.stderr(`channels list failed: ${(e as Error).message}\n`);
    return ExitCode.UPSTREAM;
  }
  if (res.status === 403) {
    ctx.stderr("Forbidden\n");
    return ExitCode.FORBIDDEN;
  }
  if (res.status >= 500) {
    ctx.stderr(`Server error: ${res.status}\n`);
    return ExitCode.UPSTREAM;
  }
  const parsed = res.json<{ channels: { name: string; type?: string; service?: string }[] }>();
  if (json) {
    ctx.stdout(JSON.stringify(parsed) + "\n");
    return ExitCode.OK;
  }
  if (!parsed.channels || parsed.channels.length === 0) {
    ctx.stdout("No channels configured.\n");
    return ExitCode.OK;
  }
  for (const ch of parsed.channels) {
    ctx.stdout(`${ch.name} | ${ch.service ?? (ch as any).type ?? ""}\n`);
  }
  return ExitCode.OK;
}
