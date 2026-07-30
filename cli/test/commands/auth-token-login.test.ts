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
  tmpDir = await fs.mkdtemp(join(tmpdir(), "dovecote-token-"));
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

function whoamiSuccess() {
  return new Response(
    JSON.stringify({
      userId: "u1",
      tokenId: "t1",
      scopes: ["dovecote:notify"],
      expiresAt: 1750000000000,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function whoami401() {
  return new Response("unauthorized", { status: 401 });
}

test("token login: dvct_abc whoami 200 writes config with token and prints tokenId", async () => {
  let i = 0;
  const { fetch: fetchImpl, calls } = makeFetch([
    (call) => {
      if (call.url.includes("/v1/auth/whoami")) return whoamiSuccess();
      return null;
    },
  ]);

  const out: string[] = [];
  const code = await runAuthLogin(
    {
      argv: ["--token", "--server-url", "https://srv"],
      globalFlags: { json: false, quiet: false, verbose: false },
      env: {}, // no DOVECOTE_CLIENT_ID required for --token
      stdout: (s) => out.push(s),
      stderr: () => {},
      configPath: cfgPath,
      fetchImpl,
    },
    { readStdin: async () => "dvct_abc" }
  );
  expect(code).toBe(ExitCode.OK);
  const stdout = out.join("");
  expect(stdout).toContain("tokenId=t1");
  const cfg = await readConfig(cfgPath);
  expect(cfg?.tokens[0]?.token).toBe("dvct_abc");
  expect(cfg?.tokens[0]?.tokenId).toBe("t1");
  expect(cfg?.tokens[0]?.userId).toBe("u1");
  expect(cfg?.tokens[0]?.scopes).toEqual(["dovecote:notify"]);
  expect(cfg?.tokens[0]?.expiresAt).toBe(1750000000000);
  expect(calls.length).toBe(1);
  expect(calls[0]!.url).toContain("/v1/auth/whoami");
  const headers = (calls[0]!.init?.headers as any) || {};
  const auth = headers["Authorization"] || headers["authorization"] || "";
  expect(auth).toContain("Bearer dvct_abc");
});

test("token login: dvct_bad whoami 401 → CliError OAUTH_FAILED containing 'invalid or expired'", async () => {
  let i = 0;
  const { fetch: fetchImpl } = makeFetch([
    (call) => {
      if (call.url.includes("/v1/auth/whoami")) return whoami401();
      return null;
    },
  ]);

  try {
    await runAuthLogin(
      {
        argv: ["--token", "--server-url", "https://srv"],
        globalFlags: { json: false, quiet: false, verbose: false },
        env: {},
        stdout: () => {},
        stderr: () => {},
        configPath: cfgPath,
        fetchImpl,
      },
      { readStdin: async () => "dvct_bad" }
    );
    throw new Error("expected throw");
  } catch (e: any) {
    expect(e).toBeInstanceOf(CliError);
    expect(e.code).toBe(ExitCode.OAUTH_FAILED);
    expect(String(e.message)).toContain("invalid or expired");
  }
  // ensure no config written
  const cfg = await readConfig(cfgPath);
  expect(cfg).toBeNull();
});

test("token login: whoami 500 → CliError UPSTREAM; config not written", async () => {
  const { fetch: fetchImpl } = makeFetch([
    (call) => {
      if (call.url.includes("/v1/auth/whoami")) return new Response("boom", { status: 500 });
      return null;
    },
  ]);

  try {
    await runAuthLogin(
      {
        argv: ["--token", "--server-url", "https://srv"],
        globalFlags: { json: false, quiet: false, verbose: false },
        env: {},
        stdout: () => {},
        stderr: () => {},
        configPath: cfgPath,
        fetchImpl,
      },
      { readStdin: async () => "dvct_abc" }
    );
    throw new Error("expected throw");
  } catch (e: any) {
    expect(e).toBeInstanceOf(CliError);
    expect(e.code).toBe(ExitCode.UPSTREAM);
    expect(String(e.message)).toContain("HTTP 500");
  }
  const cfg = await readConfig(cfgPath);
  expect(cfg).toBeNull();
});

test("token login: fetch rejection (DNS failure) → CliError UPSTREAM, not a raw TypeError", async () => {
  const fetchImpl = (async () => {
    throw new TypeError("fetch failed: dns error");
  }) as unknown as typeof fetch;

  try {
    await runAuthLogin(
      {
        argv: ["--token", "--server-url", "https://srv"],
        globalFlags: { json: false, quiet: false, verbose: false },
        env: {},
        stdout: () => {},
        stderr: () => {},
        configPath: cfgPath,
        fetchImpl,
      },
      { readStdin: async () => "dvct_abc" }
    );
    throw new Error("expected throw");
  } catch (e: any) {
    expect(e).toBeInstanceOf(CliError);
    expect(e.code).toBe(ExitCode.UPSTREAM);
    expect(String(e.message)).toContain("dns error");
  }
  const cfg = await readConfig(cfgPath);
  expect(cfg).toBeNull();
});

test("token login: non-dvct token → USAGE without calling fetch", async () => {
  const { fetch: fetchImpl, calls } = makeFetch([
    () => new Response("no", { status: 500 }),
  ]);
  const code = await runAuthLogin(
    {
      argv: ["--token", "--server-url", "https://srv"],
      globalFlags: { json: false, quiet: false, verbose: false },
      env: {},
      stdout: () => {},
      stderr: () => {},
      configPath: cfgPath,
      fetchImpl,
    },
    { readStdin: async () => "not-a-token" }
  );
  expect(code).toBe(ExitCode.USAGE);
  expect(calls.length).toBe(0);
});

test("token login: empty stdin → USAGE 'no token provided'", async () => {
  const { fetch: fetchImpl, calls } = makeFetch([
    () => new Response("no", { status: 500 }),
  ]);
  const err: string[] = [];
  const code = await runAuthLogin(
    {
      argv: ["--token", "--server-url", "https://srv"],
      globalFlags: { json: false, quiet: false, verbose: false },
      env: {},
      stdout: () => {},
      stderr: (s) => err.push(s),
      configPath: cfgPath,
      fetchImpl,
    },
    { readStdin: async () => "" }
  );
  expect(code).toBe(ExitCode.USAGE);
  expect(err.join("")).toContain("no token provided");
  expect(calls.length).toBe(0);
});
