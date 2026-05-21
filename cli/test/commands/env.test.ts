import { test, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMain } from "../../src/main.ts";
import { ExitCode } from "../../src/exit-codes.ts";
import { writeConfig } from "../../src/config.ts";

let tmpDir: string;
let cfgPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), "dovecote-env-"));
  cfgPath = join(tmpDir, "config.json");
  await writeConfig(
    {
      serverUrl: "https://srv",
      tokens: [
        {
          tokenId: "tid_a",
          token: "dvct_a",
          userId: "operator",
          scopes: ["dovecote:env:read"],
          expiresAt: Date.now() + 90 * 86400 * 1000,
        },
      ],
    },
    cfgPath
  );
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeFetch(handler: (url: string) => Response): typeof fetch {
  return (async (input: any) => handler(typeof input === "string" ? input : input.url)) as typeof fetch;
}

test("env get prints value to stdout and warning to stderr", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMain({
    argv: ["env", "get", "prod"],
    env: { HOME: "/no" },
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    configPath: cfgPath,
    fetchImpl: makeFetch(() =>
      new Response(JSON.stringify({ profile: "prod", value: "FOO=bar\n" }), {
        status: 200,
      })
    ),
  });
  expect(code).toBe(ExitCode.OK);
  expect(out.join("")).toContain("FOO=bar");
  expect(err.join("")).toContain("WARNING");
});

test("env get invalid profile name → exit 2 before HTTP", async () => {
  let called = false;
  const code = await runMain({
    argv: ["env", "get", "../etc"],
    env: { HOME: "/no" },
    stdout: () => {},
    stderr: () => {},
    configPath: cfgPath,
    fetchImpl: makeFetch(() => {
      called = true;
      return new Response("", { status: 200 });
    }),
  });
  expect(code).toBe(ExitCode.USAGE);
  expect(called).toBe(false);
});

test("env get exit 4 on 404", async () => {
  const code = await runMain({
    argv: ["env", "get", "unknown"],
    env: { HOME: "/no" },
    stdout: () => {},
    stderr: () => {},
    configPath: cfgPath,
    fetchImpl: makeFetch(
      () => new Response(JSON.stringify({ error: "not_found" }), { status: 404 })
    ),
  });
  expect(code).toBe(ExitCode.NOT_FOUND);
});
