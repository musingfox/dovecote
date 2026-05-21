import type { CmdCtx } from "../../main.ts";
import { CliError, ExitCode } from "../../exit-codes.ts";
import { parseCommandArgs } from "../../argv.ts";
import { readConfig, resolveServerUrl, clearConfig } from "../../config.ts";
import { createHttpClient } from "../../http.ts";

export async function runTokensRevoke(ctx: CmdCtx): Promise<number> {
  const { positionals } = parseCommandArgs(ctx.argv, {});
  const tokenId = positionals[0];
  if (!tokenId) {
    ctx.stderr("Usage: dovecote tokens revoke <tokenId>\n");
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
      method: "DELETE",
      path: `/v1/tokens/${tokenId}`,
    });
  } catch (e) {
    if (e instanceof CliError) {
      ctx.stderr(`${e.message}\n`);
      return e.code;
    }
    return ExitCode.UPSTREAM;
  }
  if (res.status === 403) return ExitCode.FORBIDDEN;
  if (res.status === 404) {
    ctx.stderr(`Token not found: ${tokenId}\n`);
    return ExitCode.NOT_FOUND;
  }
  if (res.status >= 500) {
    ctx.stderr(`Server error: ${res.status}\n`);
    return ExitCode.UPSTREAM;
  }

  // If revoked id matches local, clear config.
  const localMatch =
    config &&
    config.tokens.find((t) => t.tokenId === tokenId) !== undefined;
  if (localMatch) {
    await clearConfig(ctx.configPath);
    ctx.stdout(`Revoked tokenId=${tokenId}. Local config cleared.\n`);
  } else {
    ctx.stdout(`Revoked tokenId=${tokenId}\n`);
  }
  return ExitCode.OK;
}
