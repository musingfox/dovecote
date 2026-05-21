import type { CmdCtx } from "../../main.ts";
import { CliError, ExitCode } from "../../exit-codes.ts";
import { readConfig, clearConfig, resolveServerUrl } from "../../config.ts";
import { createHttpClient } from "../../http.ts";

export async function runAuthLogout(ctx: CmdCtx): Promise<number> {
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
    configPath: ctx.configPath,
    env: ctx.env,
    fetchImpl: ctx.fetchImpl,
    now: ctx.now,
  });

  let res;
  let serverFailed = false;
  let serverExpired = false;
  try {
    res = await client.request({
      method: "DELETE",
      path: `/v1/tokens/${tok.tokenId}`,
    });
  } catch (e) {
    if (e instanceof CliError && e.code === ExitCode.TOKEN_EXPIRED) {
      serverExpired = true;
    } else {
      serverFailed = true;
    }
  }

  await clearConfig(ctx.configPath);

  if (serverExpired) {
    ctx.stderr("Token already expired on server. Config cleared.\n");
    return ExitCode.TOKEN_EXPIRED;
  }
  if (serverFailed || (res && res.status >= 500)) {
    ctx.stderr("Server returned 5xx during revoke; config cleared locally.\n");
    return ExitCode.UPSTREAM;
  }
  if (res && res.status === 401) {
    ctx.stderr("Token already expired on server. Config cleared.\n");
    return ExitCode.TOKEN_EXPIRED;
  }
  ctx.stdout("Logged out.\n");
  return ExitCode.OK;
}
