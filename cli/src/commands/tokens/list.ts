import type { CmdCtx } from "../../main.ts";
import { ExitCode } from "../../exit-codes.ts";
import { parseCommandArgs } from "../../argv.ts";
import { readConfig } from "../../config.ts";

export async function runTokensList(ctx: CmdCtx): Promise<number> {
  const { values } = parseCommandArgs(ctx.argv, { json: { type: "boolean" } });
  const json = !!values.json || ctx.globalFlags.json;
  const config = await readConfig(ctx.configPath);
  if (!config) {
    ctx.stderr("No local config. Run `dovecote auth login`.\n");
    return ExitCode.NO_CONFIG;
  }
  if (!config.tokens || config.tokens.length === 0) {
    if (json) ctx.stdout("[]\n");
    else ctx.stdout("No local tokens. Run `dovecote auth login`.\n");
    return ExitCode.OK;
  }
  if (json) {
    ctx.stdout(
      JSON.stringify(
        config.tokens.map((t) => ({
          tokenId: t.tokenId,
          label: t.label,
          expiresAt: t.expiresAt,
          scopes: t.scopes,
        }))
      ) + "\n"
    );
    return ExitCode.OK;
  }
  for (const t of config.tokens) {
    ctx.stdout(
      `${t.tokenId} | ${t.label ?? "(no label)"} | ${new Date(t.expiresAt).toISOString()} | ${t.scopes.join(",")}\n`
    );
  }
  return ExitCode.OK;
}
