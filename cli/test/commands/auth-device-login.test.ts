import { test, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode, CliError } from "../../src/exit-codes.ts";
import { runAuthLogin } from "../../src/commands/auth/login.ts";
import { readConfig } from "../../src/config.ts";

let tmpDir: string;
let cfgPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), "dovecote-device-"));
  cfgPath = join(tmpDir, "config.json");
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function makeFetch(handlers: ((call: FetchCall, i: number) => Response | null)[]): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetchImpl = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    const call: FetchCall = { url, init };
    calls.push(call);
    for (const h of handlers) {
      const res = h(call, i);
      if (res) {
        i++;
        return res;
      }
    }
    throw new Error(`no handler matched ${url}`);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function authorizeResponse(interval = 1) {
  return new Response(
    JSON.stringify({
      device_code: "DC",
      user_code: "BCDF-GHJK",
      verification_uri: "https://e/device",
      verification_uri_complete: "https://e/device?user_code=BCDF-GHJK",
      expires_in: 600,
      interval,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function pollPending() {
  return new Response(JSON.stringify({ error: "authorization_pending" }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

function pollSuccess(opts: { userId?: string } = {}) {
  return new Response(
    JSON.stringify({
      token: "dvct_device",
      tokenId: "tid_device",
      userId: opts.userId ?? "alice",
      scopes: ["dovecote:notify"],
      expiresAt: Date.now() + 7_776_000_000,
      label: "dovecote-cli",
    }),
    { status: 201, headers: { "content-type": "application/json" } },
  );
}

test("device login: authorize → pending → pending → success writes config", async () => {
  const responses = [
    authorizeResponse(),
    pollPending(),
    pollPending(),
    pollSuccess(),
  ];
  let i = 0;
  const { fetch: fetchImpl, calls } = makeFetch([
    () => responses[i++] ?? null,
  ]);

  const sleeps: number[] = [];
  const out: string[] = [];
  const code = await runAuthLogin(
    {
      argv: ["--device", "--server-url", "https://srv"],
      globalFlags: { json: false, quiet: false, verbose: false },
      env: { DOVECOTE_CLIENT_ID: "cli-test" },
      stdout: (s) => out.push(s),
      stderr: () => {},
      configPath: cfgPath,
      fetchImpl,
    },
    { sleep: async (ms) => { sleeps.push(ms); }, isTTY: false },
  );
  expect(code).toBe(ExitCode.OK);
  // Stdout shows the user_code and the success line.
  const stdout = out.join("");
  expect(stdout).toContain("BCDF-GHJK");
  expect(stdout).toContain("Logged in.");
  // Only the initial "Waiting for approval..." line — NOT per-poll spam.
  expect((stdout.match(/Waiting for approval/g) ?? []).length).toBe(1);
  // Config written.
  const cfg = await readConfig(cfgPath);
  expect(cfg?.tokens[0]?.token).toBe("dvct_device");
  expect(cfg?.tokens[0]?.tokenId).toBe("tid_device");
  expect(cfg?.tokens[0]?.userId).toBe("alice");
  // Sanity on fetch call sequence: 1 authorize + 3 polls.
  expect(calls.length).toBe(4);
  expect(calls[0]!.url).toContain("/v1/auth/device-authorize");
  for (let n = 1; n < 4; n++) {
    expect(calls[n]!.url).toContain("/v1/auth/exchange-device");
  }
});

test("device login: slow_down bumps wait interval", async () => {
  const responses = [
    authorizeResponse(1),
    new Response(JSON.stringify({ error: "slow_down", interval: 2 }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }),
    pollSuccess(),
  ];
  let i = 0;
  const { fetch: fetchImpl } = makeFetch([() => responses[i++] ?? null]);

  const sleeps: number[] = [];
  const code = await runAuthLogin(
    {
      argv: ["--device", "--server-url", "https://srv"],
      globalFlags: { json: false, quiet: false, verbose: false },
      env: { DOVECOTE_CLIENT_ID: "cli-test" },
      stdout: () => {},
      stderr: () => {},
      configPath: cfgPath,
      fetchImpl,
    },
    { sleep: async (ms) => { sleeps.push(ms); }, isTTY: false },
  );
  expect(code).toBe(ExitCode.OK);
  // Sleep sequence: first poll waits 1s (initial), then after slow_down the next
  // sleep is >= 2000ms (the new interval).
  expect(sleeps[0]).toBe(1000);
  expect(sleeps[1]).toBeGreaterThanOrEqual(2000);
});

test("device login: expired_token → CliError(OAUTH_FAILED)", async () => {
  const responses = [
    authorizeResponse(),
    new Response(JSON.stringify({ error: "expired_token" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }),
  ];
  let i = 0;
  const { fetch: fetchImpl } = makeFetch([() => responses[i++] ?? null]);

  try {
    await runAuthLogin(
      {
        argv: ["--device", "--server-url", "https://srv"],
        globalFlags: { json: false, quiet: false, verbose: false },
        env: { DOVECOTE_CLIENT_ID: "cli-test" },
        stdout: () => {},
        stderr: () => {},
        configPath: cfgPath,
        fetchImpl,
      },
      { sleep: async () => {}, isTTY: false },
    );
    throw new Error("expected throw");
  } catch (e: any) {
    expect(e).toBeInstanceOf(CliError);
    expect(e.code).toBe(ExitCode.OAUTH_FAILED);
    expect(String(e.message)).toContain("expired");
  }
});

test("device login: access_denied → CliError(OAUTH_FAILED) with 'denied' in message", async () => {
  const responses = [
    authorizeResponse(),
    new Response(JSON.stringify({ error: "access_denied" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }),
  ];
  let i = 0;
  const { fetch: fetchImpl } = makeFetch([() => responses[i++] ?? null]);

  try {
    await runAuthLogin(
      {
        argv: ["--device", "--server-url", "https://srv"],
        globalFlags: { json: false, quiet: false, verbose: false },
        env: { DOVECOTE_CLIENT_ID: "cli-test" },
        stdout: () => {},
        stderr: () => {},
        configPath: cfgPath,
        fetchImpl,
      },
      { sleep: async () => {}, isTTY: false },
    );
    throw new Error("expected throw");
  } catch (e: any) {
    expect(e).toBeInstanceOf(CliError);
    expect(e.code).toBe(ExitCode.OAUTH_FAILED);
    expect(String(e.message).toLowerCase()).toContain("denied");
  }
});

test("device login: authorize 503 misconfigured → CliError(UPSTREAM)", async () => {
  const responses = [
    new Response(JSON.stringify({ error: "misconfigured" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    }),
  ];
  let i = 0;
  const { fetch: fetchImpl } = makeFetch([() => responses[i++] ?? null]);

  try {
    await runAuthLogin(
      {
        argv: ["--device", "--server-url", "https://srv"],
        globalFlags: { json: false, quiet: false, verbose: false },
        env: { DOVECOTE_CLIENT_ID: "cli-test" },
        stdout: () => {},
        stderr: () => {},
        configPath: cfgPath,
        fetchImpl,
      },
      { sleep: async () => {}, isTTY: false },
    );
    throw new Error("expected throw");
  } catch (e: any) {
    expect(e).toBeInstanceOf(CliError);
    expect(e.code).toBe(ExitCode.UPSTREAM);
  }
});

test("device login: missing client_id → exit USAGE without contacting server", async () => {
  const { fetch: fetchImpl, calls } = makeFetch([
    () => new Response("nope", { status: 500 }),
  ]);
  const err: string[] = [];
  const code = await runAuthLogin(
    {
      argv: ["--device", "--server-url", "https://srv"],
      globalFlags: { json: false, quiet: false, verbose: false },
      env: {},
      stdout: () => {},
      stderr: (s) => err.push(s),
      configPath: cfgPath,
      fetchImpl,
    },
    { sleep: async () => {}, isTTY: false },
  );
  expect(code).toBe(ExitCode.USAGE);
  expect(calls.length).toBe(0);
});

test("device login: works without TTY (no TTY guard in device branch)", async () => {
  const responses = [authorizeResponse(), pollSuccess()];
  let i = 0;
  const { fetch: fetchImpl } = makeFetch([() => responses[i++] ?? null]);

  const code = await runAuthLogin(
    {
      argv: ["--device", "--server-url", "https://srv"],
      globalFlags: { json: false, quiet: false, verbose: false },
      env: { DOVECOTE_CLIENT_ID: "cli-test" },
      stdout: () => {},
      stderr: () => {},
      configPath: cfgPath,
      fetchImpl,
    },
    { sleep: async () => {}, isTTY: false },
  );
  expect(code).toBe(ExitCode.OK);
});
