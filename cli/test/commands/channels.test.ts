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
  tmpDir = await fs.mkdtemp(join(tmpdir(), "dovecote-ch-"));
  cfgPath = join(tmpDir, "config.json");
  await writeConfig(
    {
      serverUrl: "https://srv",
      tokens: [
        {
          tokenId: "tid_a",
          token: "dvct_a",
          userId: "operator",
          scopes: ["dovecote:notify"],
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

test("channels list prints rows", async () => {
  const out: string[] = [];
  const code = await runMain({
    argv: ["channels", "list"],
    env: { HOME: "/no" },
    stdout: (s) => out.push(s),
    stderr: () => {},
    configPath: cfgPath,
    fetchImpl: makeFetch(() =>
      new Response(
        JSON.stringify({
          channels: [{ id: "slack-ops", name: "ops", service: "slack" }],
        }),
        { status: 200 }
      )
    ),
  });
  expect(code).toBe(ExitCode.OK);
  expect(out.join("")).toContain("slack-ops");
  expect(out.join("")).toContain("ops");
  expect(out.join("")).toContain("slack");
});

test("channels list prints 'No channels configured.' on empty list", async () => {
  const out: string[] = [];
  const code = await runMain({
    argv: ["channels", "list"],
    env: { HOME: "/no" },
    stdout: (s) => out.push(s),
    stderr: () => {},
    configPath: cfgPath,
    fetchImpl: makeFetch(() =>
      new Response(JSON.stringify({ channels: [] }), { status: 200 })
    ),
  });
  expect(code).toBe(ExitCode.OK);
  expect(out.join("")).toContain("No channels");
});

test("channels list exit 6 on 403", async () => {
  const code = await runMain({
    argv: ["channels", "list"],
    env: { HOME: "/no" },
    stdout: () => {},
    stderr: () => {},
    configPath: cfgPath,
    fetchImpl: makeFetch(
      () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })
    ),
  });
  expect(code).toBe(ExitCode.FORBIDDEN);
});

test("channels test sends probe", async () => {
  const out: string[] = [];
  const code = await runMain({
    argv: ["channels", "test", "ops"],
    env: { HOME: "/no" },
    stdout: (s) => out.push(s),
    stderr: () => {},
    configPath: cfgPath,
    fetchImpl: makeFetch(() =>
      new Response(JSON.stringify({ success: true, messageId: "m_2" }), {
        status: 200,
      })
    ),
  });
  expect(code).toBe(ExitCode.OK);
  expect(out.join("")).toContain("m_2");
});

test("channels test exit 4 on 404", async () => {
  const code = await runMain({
    argv: ["channels", "test", "ghost"],
    env: { HOME: "/no" },
    stdout: () => {},
    stderr: () => {},
    configPath: cfgPath,
    fetchImpl: makeFetch(() =>
      new Response(JSON.stringify({ error: "not_found" }), { status: 404 })
    ),
  });
  expect(code).toBe(ExitCode.NOT_FOUND);
});
