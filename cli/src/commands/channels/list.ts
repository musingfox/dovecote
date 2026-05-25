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
  const parsed = res.json<{
    channels: { id?: string; name: string; type?: string; service?: string }[];
  }>();
  if (json) {
    ctx.stdout(JSON.stringify(parsed) + "\n");
    return ExitCode.OK;
  }
  if (!parsed.channels || parsed.channels.length === 0) {
    ctx.stdout("No channels configured.\n");
    return ExitCode.OK;
  }
  for (const ch of parsed.channels) {
    // Print the channel id (what `dovecote notify <id>` takes), then the
    // human display name, then the service kind. Previously printed only
    // `name | service` which omitted the id — making it impossible for
    // operators or the `channel:add` script to enumerate channel ids.
    const id = ch.id ?? ch.name;
    const service = ch.service ?? (ch as any).type ?? "";
    ctx.stdout(`${id} | ${ch.name} | ${service}\n`);
  }
  return ExitCode.OK;
}
