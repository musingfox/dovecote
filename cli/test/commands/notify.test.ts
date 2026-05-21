import { test, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMain } from "../../src/main.ts";
import { ExitCode } from "../../src/exit-codes.ts";
import { writeConfig } from "../../src/config.ts";
import { runNotify } from "../../src/commands/notify.ts";

let tmpDir: string;
let cfgPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), "dovecote-notify-"));
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

function makeFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    return handler(url, init);
  }) as typeof fetch;
}

test("notify sends and prints messageId on 200", async () => {
  const out: string[] = [];
  const code = await runMain({
    argv: ["notify", "ops", "--text", "hello"],
    env: { HOME: "/no" },
    stdout: (s) => out.push(s),
    stderr: () => {},
    configPath: cfgPath,
    fetchImpl: makeFetch((url) => {
      if (url.endsWith("/v1/notify"))
        return new Response(
          JSON.stringify({ success: true, channel: "ops", messageId: "m_1" }),
          { status: 200 }
        );
      return new Response("404", { status: 404 });
    }),
  });
  expect(code).toBe(ExitCode.OK);
  expect(out.join("")).toContain("m_1");
});

test("notify exit 2 on mutually-exclusive content flags", async () => {
  const code = await runMain({
    argv: ["notify", "ops", "--text", "x", "--stdin"],
    env: { HOME: "/no" },
    stdout: () => {},
    stderr: () => {},
    configPath: cfgPath,
  });
  expect(code).toBe(ExitCode.USAGE);
});

test("notify exit 4 on 404 channel-not-found", async () => {
  const code = await runMain({
    argv: ["notify", "missing", "--text", "x"],
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

test("notify exit 6 on 403", async () => {
  const code = await runMain({
    argv: ["notify", "ops", "--text", "x"],
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

test("notify retries on 5xx and succeeds on 4th attempt → exit 0", async () => {
  const statuses = [503, 502, 500, 200];
  let i = 0;
  const sleeps: number[] = [];
  const out: string[] = [];
  const code = await runNotify(
    {
      argv: ["ops", "--text", "hi", "--retry", "4"],
      globalFlags: { json: false, quiet: false, verbose: false },
      env: { HOME: "/no" },
      stdout: (s) => out.push(s),
      stderr: () => {},
      configPath: cfgPath,
      fetchImpl: ((async () => {
        const status = statuses[i++] ?? 500;
        return new Response(
          status === 200
            ? JSON.stringify({ success: true, channel: "ops", messageId: "m_42" })
            : "err",
          { status }
        );
      }) as unknown as typeof fetch),
    },
    { sleep: async (ms) => { sleeps.push(ms); } }
  );
  expect(code).toBe(ExitCode.OK);
  expect(out.join("")).toContain("m_42");
  expect(i).toBe(4); // four fetch calls total
  // Backoff approx 1s, 2s, 4s — jitter ≤ 250ms each, cap 5000.
  expect(sleeps.length).toBe(3);
  expect(sleeps[0]).toBeGreaterThanOrEqual(1000);
  expect(sleeps[0]).toBeLessThan(1300);
  expect(sleeps[1]).toBeGreaterThanOrEqual(2000);
  expect(sleeps[1]).toBeLessThan(2300);
  expect(sleeps[2]).toBeGreaterThanOrEqual(4000);
  expect(sleeps[2]).toBeLessThan(4300);
});

test("notify 5xx five attempts exhausted → exit 7 (UPSTREAM)", async () => {
  let calls = 0;
  const code = await runNotify(
    {
      argv: ["ops", "--text", "hi", "--retry", "5"],
      globalFlags: { json: false, quiet: false, verbose: false },
      env: { HOME: "/no" },
      stdout: () => {},
      stderr: () => {},
      configPath: cfgPath,
      fetchImpl: ((async () => {
        calls++;
        return new Response("server error", { status: 500 });
      }) as unknown as typeof fetch),
    },
    { sleep: async () => {} }
  );
  expect(code).toBe(ExitCode.UPSTREAM);
  expect(calls).toBe(5);
});

test("notify 429 five attempts exhausted → exit 7 (UPSTREAM)", async () => {
  let calls = 0;
  const code = await runNotify(
    {
      argv: ["ops", "--text", "hi", "--retry", "5"],
      globalFlags: { json: false, quiet: false, verbose: false },
      env: { HOME: "/no" },
      stdout: () => {},
      stderr: () => {},
      configPath: cfgPath,
      fetchImpl: ((async () => {
        calls++;
        return new Response(
          JSON.stringify({ error: "rate_limited" }),
          { status: 429, headers: { "Retry-After": "60" } }
        );
      }) as unknown as typeof fetch),
    },
    { sleep: async () => {} }
  );
  expect(code).toBe(ExitCode.UPSTREAM);
  expect(calls).toBe(5);
});

test("notify --dry-run prints content and skips HTTP", async () => {
  let called = false;
  const out: string[] = [];
  const code = await runMain({
    argv: ["notify", "ops", "--text", "hi", "--dry-run"],
    env: { HOME: "/no" },
    stdout: (s) => out.push(s),
    stderr: () => {},
    configPath: cfgPath,
    fetchImpl: makeFetch(() => {
      called = true;
      return new Response("", { status: 200 });
    }),
  });
  expect(code).toBe(ExitCode.OK);
  expect(called).toBe(false);
  expect(out.join("")).toContain("dry-run");
});
