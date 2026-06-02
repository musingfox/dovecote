import { promises as fs } from "node:fs";
import { basename, extname } from "node:path";
import type { CmdCtx } from "../main.ts";
import { CliError, ExitCode } from "../exit-codes.ts";
import { parseCommandArgs } from "../argv.ts";
import { readConfig, resolveServerUrl } from "../config.ts";
import { createHttpClient } from "../http.ts";
import { parseRetryAfter } from "../retry-after.ts";

export interface NotifyDeps {
  /** Override sleep for tests (defaults to real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

export async function runNotify(ctx: CmdCtx, deps: NotifyDeps = {}): Promise<number> {
  const doSleep = deps.sleep ?? sleep;
  const { values, positionals } = parseCommandArgs(ctx.argv, {
    text: { type: "string" },
    stdin: { type: "boolean" },
    "embed-json": { type: "string" },
    image: { type: "string" },
    attach: { type: "string" },
    "dry-run": { type: "boolean" },
    retry: { type: "string" },
  });
  const channel = positionals[0];
  if (!channel) {
    ctx.stderr("Usage: dovecote notify <channel> [--text|--stdin|--embed-json] [--image|--attach <path>]\n");
    return ExitCode.USAGE;
  }
  const text = values.text as string | undefined;
  const useStdin = !!values.stdin;
  const embedJson = values["embed-json"] as string | undefined;
  const imagePath = (values.image as string | undefined) ?? (values.attach as string | undefined);
  const contentFlags = [text, useStdin ? "stdin" : undefined, embedJson].filter(
    (x) => x !== undefined
  );
  if (contentFlags.length > 1) {
    ctx.stderr("--text, --stdin, --embed-json are mutually exclusive\n");
    return ExitCode.USAGE;
  }
  // --image/--attach is orthogonal: it may stand alone or accompany any of the
  // mutually-exclusive content sources (e.g. an embed referencing the file).
  if (contentFlags.length === 0 && imagePath === undefined) {
    ctx.stderr("One of --text, --stdin, --embed-json, or --image is required\n");
    return ExitCode.USAGE;
  }

  let content: any;
  if (text !== undefined) {
    content = { text };
  } else if (useStdin) {
    const stdinText = await readStdin();
    content = { text: stdinText };
  } else if (embedJson !== undefined) {
    const text2 = await fs.readFile(embedJson, "utf-8");
    content = JSON.parse(text2);
  } else {
    content = {};
  }

  if (imagePath !== undefined) {
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(imagePath);
    } catch {
      ctx.stderr(`Attachment file not found or unreadable: ${imagePath}\n`);
      return ExitCode.USAGE;
    }
    content.attachment = {
      filename: basename(imagePath),
      data: bytes.toString("base64"),
      contentType: guessContentType(imagePath),
    };
  }

  const retry = Math.max(1, parseInt((values.retry as string) ?? "1", 10) || 1);

  if (values["dry-run"]) {
    ctx.stdout(
      `[dry-run] channel=${channel} content=${JSON.stringify(content)}\n`
    );
    return ExitCode.OK;
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

  let lastStatus = 0;
  let lastBody = "";
  for (let attempt = 1; attempt <= retry; attempt++) {
    try {
      const res = await client.request({
        method: "POST",
        path: "/v1/notify",
        body: { channel, content },
      });
      lastStatus = res.status;
      lastBody = res.body;
      if (res.status >= 200 && res.status < 300) {
        const parsed = JSON.parse(res.body);
        if (ctx.globalFlags.json) {
          ctx.stdout(JSON.stringify(parsed) + "\n");
        } else {
          ctx.stdout(
            `Sent: messageId=${parsed.messageId ?? "(none)"} channel=${parsed.channel ?? channel}\n`
          );
        }
        return ExitCode.OK;
      }
      if (res.status === 403) {
        ctx.stderr(`Forbidden: ${res.body}\n`);
        return ExitCode.FORBIDDEN;
      }
      if (res.status === 404) {
        ctx.stderr(`Channel not found: ${channel}\n`);
        return ExitCode.NOT_FOUND;
      }
      // 429 with Retry-After → cooperate with server-provided pacing.
      if (res.status === 429 && attempt < retry) {
        const retryAfter = res.headers.get("Retry-After");
        if (retryAfter === null) {
          await doSleep(backoffMs(attempt));
          continue;
        }

        const seconds = parseRetryAfter(
          retryAfter,
          ctx.now ? ctx.now() : Date.now()
        );
        if (seconds === null) {
          ctx.stderr(
            `Warning: malformed Retry-After header: ${retryAfter}; using fixed backoff\n`
          );
          await doSleep(backoffMs(attempt));
          continue;
        }

        const cappedSeconds = Math.min(seconds, 300);
        if (seconds > 300) {
          ctx.stderr("Warning: Retry-After exceeds 5 min cap; sleeping 300s\n");
        }
        await doSleep(cappedSeconds * 1000);
        continue;
      }

      // 5xx / 429 without Retry-After → retry with fixed backoff
      if (attempt < retry) {
        const wait = backoffMs(attempt);
        await doSleep(wait);
        continue;
      }
    } catch (e) {
      if (e instanceof CliError && e.code === ExitCode.TOKEN_EXPIRED) {
        ctx.stderr(`${e.message}\n`);
        return ExitCode.TOKEN_EXPIRED;
      }
      if (attempt < retry) {
        await doSleep(backoffMs(attempt));
        continue;
      }
      ctx.stderr(`Notify failed: ${(e as Error).message}\n`);
      return ExitCode.UPSTREAM;
    }
  }
  ctx.stderr(`Notify failed after ${retry} attempts: status=${lastStatus} body=${lastBody}\n`);
  return ExitCode.UPSTREAM;
}

function guessContentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    default:
      return "application/octet-stream";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  const base = 1000 * Math.pow(2, attempt - 1);
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(5000, base + jitter);
}

async function readStdin(): Promise<string> {
  let data = "";
  return new Promise((resolve) => {
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
  });
}
