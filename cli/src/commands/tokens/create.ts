import type { CmdCtx } from "../../main.ts";
import { CliError, ExitCode } from "../../exit-codes.ts";
import { parseCommandArgs } from "../../argv.ts";
import { readConfig, resolveServerUrl } from "../../config.ts";
import { createHttpClient } from "../../http.ts";

export async function runTokensCreate(ctx: CmdCtx): Promise<number> {
  const { values } = parseCommandArgs(ctx.argv, {
    scope: { type: "string", multiple: true },
    expires: { type: "string" },
    label: { type: "string" },
    user: { type: "string" },
  });
  const scopes = (values.scope as string[] | undefined) ?? [];
  if (!Array.isArray(scopes) || scopes.length === 0) {
    ctx.stderr("At least one --scope is required\n");
    return ExitCode.USAGE;
  }
  const expires = values.expires as string | undefined;
  if (expires && !["7d", "30d", "60d", "90d"].includes(expires)) {
    ctx.stderr(`Invalid --expires value: ${expires}\n`);
    return ExitCode.USAGE;
  }
  const userId = (values.user as string | undefined) ?? "operator";
  const label = values.label as string | undefined;

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

  const body: Record<string, unknown> = { userId, scopes };
  if (label) body.label = label;
  if (expires) body.expiresIn = expires;

  let res;
  try {
    res = await client.request({ method: "POST", path: "/v1/tokens", body });
  } catch (e) {
    if (e instanceof CliError) {
      ctx.stderr(`${e.message}\n`);
      return e.code;
    }
    return ExitCode.UPSTREAM;
  }
  if (res.status === 403) return ExitCode.FORBIDDEN;
  if (res.status === 400) {
    // Discriminate by error_description so users see "scope" issues distinctly
    // from generic malformed input.
    let errDesc: string | undefined;
    try {
      const parsed = JSON.parse(res.body) as { error_description?: string };
      errDesc = parsed.error_description;
    } catch {
      // Non-JSON body — fall through to generic 400 handling.
    }
    if (errDesc === "invalid_scope") {
      ctx.stderr(`Bad request: ${res.body}\n`);
      return ExitCode.FORBIDDEN; // scope rejection — same family as 403
    }
    ctx.stderr(`Bad request: ${res.body}\n`);
    return ExitCode.USAGE; // generic 400 → caller-side input error
  }
  if (res.status >= 500) {
    ctx.stderr(`Server error: ${res.status}\n`);
    return ExitCode.UPSTREAM;
  }
  ctx.stdout(res.body + (res.body.endsWith("\n") ? "" : "\n"));
  return ExitCode.OK;
}
