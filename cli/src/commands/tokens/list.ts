import type { CmdCtx } from "../../main.ts";
import { CliError, ExitCode } from "../../exit-codes.ts";
import { parseCommandArgs } from "../../argv.ts";
import { readConfig, resolveServerUrl } from "../../config.ts";
import { createHttpClient } from "../../http.ts";

interface RemoteTokenEntry {
  tokenId: string;
  userId: string;
  scopes: string[];
  createdAt: number;
  expiresAt: number;
  label?: string;
}

interface RemoteListResponse {
  tokens: RemoteTokenEntry[];
  truncated: boolean;
}

export async function runTokensList(ctx: CmdCtx): Promise<number> {
  const { values } = parseCommandArgs(ctx.argv, {
    json: { type: "boolean" },
    remote: { type: "boolean" },
    all: { type: "boolean" },
    user: { type: "string" },
  });
  const json = !!values.json || ctx.globalFlags.json;
  const remote = !!values.remote;
  const all = !!values.all;
  const user = typeof values.user === "string" ? values.user : undefined;

  // Flag combination guards (apply BEFORE config read so usage errors are loud).
  if (all && user !== undefined) {
    throw new CliError(
      ExitCode.USAGE,
      "--all and --user= are mutually exclusive"
    );
  }
  if ((all || user !== undefined) && !remote) {
    throw new CliError(
      ExitCode.USAGE,
      "--all and --user= require --remote"
    );
  }

  const config = await readConfig(ctx.configPath);
  if (!config) {
    ctx.stderr("No local config. Run `dovecote auth login`.\n");
    return ExitCode.NO_CONFIG;
  }

  if (remote) {
    return await runRemote(ctx, config, { json, all, user });
  }

  // Local-only path (legacy behavior).
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

async function runRemote(
  ctx: CmdCtx,
  config: NonNullable<Awaited<ReturnType<typeof readConfig>>>,
  opts: { json: boolean; all: boolean; user: string | undefined }
): Promise<number> {
  const serverUrl = resolveServerUrl(config, ctx.env);
  const client = createHttpClient({
    serverUrl,
    config,
    configPath: ctx.configPath,
    env: ctx.env,
    fetchImpl: ctx.fetchImpl,
    now: ctx.now,
  });

  // Path: server-side admin (no userId) when --all; userId filter when --user;
  // self when neither.
  let path = "/v1/tokens";
  if (opts.user !== undefined) {
    path += `?userId=${encodeURIComponent(opts.user)}`;
  }

  const res = await client.request({
    method: "GET",
    path,
    timeoutMs: ctx.globalFlags.timeout,
  });
  if (res.status === 401) {
    throw new CliError(
      ExitCode.TOKEN_EXPIRED,
      "Session expired; run `dovecote auth login`"
    );
  }
  if (res.status === 403) {
    let desc = "Forbidden";
    try {
      desc = (res.json() as any).error_description ?? desc;
    } catch {
      // ignore
    }
    throw new CliError(ExitCode.FORBIDDEN, desc);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new CliError(
      ExitCode.UPSTREAM,
      `Unexpected status ${res.status} from /v1/tokens`
    );
  }

  const body = res.json<RemoteListResponse>();
  if (body.truncated) {
    ctx.stderr("warning: result truncated at 1000 tokens\n");
  }

  if (opts.json) {
    ctx.stdout(JSON.stringify(body.tokens) + "\n");
    return ExitCode.OK;
  }
  if (body.tokens.length === 0) {
    ctx.stdout("No tokens.\n");
    return ExitCode.OK;
  }
  for (const t of body.tokens) {
    ctx.stdout(
      `${t.tokenId} | ${t.userId} | ${t.label ?? "(no label)"} | ${new Date(t.expiresAt).toISOString()} | ${t.scopes.join(",")}\n`
    );
  }
  return ExitCode.OK;
}
