import type { CmdCtx } from "../../main.ts";
import { CliError, ExitCode } from "../../exit-codes.ts";
import { parseCommandArgs } from "../../argv.ts";
import { readConfig, resolveServerUrl } from "../../config.ts";
import { createHttpClient } from "../../http.ts";

// Profile must be alphanumeric / underscore / dash, length 1..64.
const PROFILE_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

export async function runEnvGet(ctx: CmdCtx): Promise<number> {
  const { positionals } = parseCommandArgs(ctx.argv, {});
  const profile = positionals[0];
  if (!profile || !PROFILE_REGEX.test(profile)) {
    ctx.stderr(`Invalid profile name: ${profile ?? "(missing)"}\n`);
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
    res = await client.request({ method: "GET", path: `/v1/env/${profile}` });
  } catch (e) {
    if (e instanceof CliError) {
      ctx.stderr(`${e.message}\n`);
      return e.code;
    }
    return ExitCode.UPSTREAM;
  }
  if (res.status === 403) return ExitCode.FORBIDDEN;
  if (res.status === 404) {
    ctx.stderr(`Profile not found: ${profile}\n`);
    return ExitCode.NOT_FOUND;
  }
  if (res.status >= 500) {
    ctx.stderr(`Server error: ${res.status}\n`);
    return ExitCode.UPSTREAM;
  }
  const parsed = res.json<{ value?: string; profile?: string }>();
  ctx.stderr(`WARNING: ${profile} may contain secrets; do not log stdout\n`);
  ctx.stdout(parsed.value ?? "");
  return ExitCode.OK;
}
