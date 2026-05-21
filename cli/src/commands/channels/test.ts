import type { CmdCtx } from "../../main.ts";
import { CliError, ExitCode } from "../../exit-codes.ts";
import { parseCommandArgs } from "../../argv.ts";
import { readConfig, resolveServerUrl } from "../../config.ts";
import { createHttpClient } from "../../http.ts";

export async function runChannelsTest(ctx: CmdCtx): Promise<number> {
  const { positionals } = parseCommandArgs(ctx.argv, {});
  const channel = positionals[0];
  if (!channel) {
    ctx.stderr("Usage: dovecote channels test <channel>\n");
    return ExitCode.USAGE;
  }
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
    res = await client.request({
      method: "POST",
      path: "/v1/notify",
      body: { channel, content: { text: "dovecote channels test probe" } },
    });
  } catch (e) {
    if (e instanceof CliError) {
      ctx.stderr(`${e.message}\n`);
      return e.code;
    }
    ctx.stderr(`channels test failed: ${(e as Error).message}\n`);
    return ExitCode.UPSTREAM;
  }
  if (res.status === 403) return ExitCode.FORBIDDEN;
  if (res.status === 404) {
    ctx.stderr(`Channel not found: ${channel}\n`);
    return ExitCode.NOT_FOUND;
  }
  if (res.status >= 500) {
    ctx.stderr(`Server error: ${res.status}\n`);
    return ExitCode.UPSTREAM;
  }
  const parsed = res.json<any>();
  ctx.stdout(`Probe sent: messageId=${parsed.messageId ?? "(none)"}\n`);
  return ExitCode.OK;
}
