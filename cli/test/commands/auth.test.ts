import { test, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMain } from "../../src/main.ts";
import { CliError, ExitCode } from "../../src/exit-codes.ts";
import { readConfig, writeConfig } from "../../src/config.ts";
import { runAuthLogin } from "../../src/commands/auth/login.ts";
import type { LoopbackServer, LoopbackServerFactory } from "../../src/auth-flow.ts";

let tmpDir: string;
let cfgPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), "dovecote-auth-"));
  cfgPath = join(tmpDir, "config.json");
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function fakeLoopback(opts: {
  code?: string;
  state?: string;
  rejectTimeout?: boolean;
}): LoopbackServerFactory {
  return async (): Promise<LoopbackServer> => {
    let captureState = "";
    return {
      redirectUri: "http://127.0.0.1:53017",
      async waitForCallback(timeoutMs: number) {
        if (opts.rejectTimeout) {
          throw new Error(`OAuth callback timeout after ${timeoutMs}ms`);
        }
        return { code: opts.code ?? "code123", state: opts.state ?? captureState };
      },
      async close() {},
    };
  };
}

function makeFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    return handler(url, init);
  }) as typeof fetch;
}

test("auth login: missing DOVECOTE_CLIENT_ID → exit 2", async () => {
  const err: string[] = [];
  const code = await runMain({
    argv: ["auth", "login"],
    env: { HOME: "/no" },
    stdout: () => {},
    stderr: (s) => err.push(s),
    configPath: cfgPath,
  });
  expect(code).toBe(ExitCode.USAGE);
  expect(err.join("")).toContain("DOVECOTE_CLIENT_ID");
});

test("auth login: writes config on success", async () => {
  // Capture the OAuth state from the authorize URL → reuse it for the loopback callback.
  let capturedState: string | undefined;

  const fetchImpl = makeFetch((url, init) => {
    if (url.startsWith("https://srv/token")) {
      return new Response(
        JSON.stringify({ access_token: "oauth_xyz", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (url.startsWith("https://srv/v1/auth/exchange")) {
      return new Response(
        JSON.stringify({
          token: "dvct_runtime",
          tokenId: "tid_runtime",
          userId: "operator",
          scopes: ["dovecote:admin", "dovecote:notify"],
          expiresAt: Date.now() + 90 * 86400 * 1000,
          label: "dovecote-cli",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("nf", { status: 404 });
  });

  // We have to intercept the state — easiest way: write a tiny custom factory that
  // first watches the next browser invocation to capture state, then resolves with it.
  const factory: LoopbackServerFactory = async () => ({
    redirectUri: "http://127.0.0.1:54321",
    async waitForCallback(_timeoutMs: number) {
      // Pretend we received the callback now; reuse state captured by browser handler.
      return { code: "auth_code_123", state: capturedState ?? "no-state" };
    },
    async close() {},
  });

  const browser = async (url: string) => {
    const u = new URL(url);
    capturedState = u.searchParams.get("state") ?? undefined;
  };

  const out: string[] = [];
  const exit = await runAuthLogin(
    {
      argv: ["--server-url", "https://srv"],
      globalFlags: { json: false, quiet: false, verbose: false },
      env: { DOVECOTE_CLIENT_ID: "cli-test", HOME: "/no" },
      stdout: (s) => out.push(s),
      stderr: () => {},
      configPath: cfgPath,
      fetchImpl,
    },
    { browser, loopbackFactory: factory, isTTY: true }
  );
  expect(exit).toBe(ExitCode.OK);
  const cfg = await readConfig(cfgPath);
  expect(cfg?.tokens[0]?.token).toBe("dvct_runtime");
  expect(cfg?.tokens[0]?.tokenId).toBe("tid_runtime");
});

test("auth login: --no-browser path prints URL and no-TTY ok", async () => {
  let capturedState: string | undefined;
  const factory: LoopbackServerFactory = async () => ({
    redirectUri: "http://127.0.0.1:54321",
    onAuthorizeUrl(url: string) {
      capturedState = new URL(url).searchParams.get("state") ?? undefined;
    },
    async waitForCallback() {
      return { code: "c", state: capturedState ?? "" };
    },
    async close() {},
  });
  const browser = async (_url: string) => {};
  const fetchImpl = makeFetch((url) => {
    if (url.includes("/token")) {
      return new Response(JSON.stringify({ access_token: "oauth_zzz" }), { status: 200 });
    }
    if (url.includes("/v1/auth/exchange")) {
      return new Response(
        JSON.stringify({
          token: "dvct_zzz",
          tokenId: "tid_zzz",
          userId: "operator",
          scopes: ["dovecote:admin"],
          expiresAt: Date.now() + 90 * 86400 * 1000,
        }),
        { status: 201 }
      );
    }
    return new Response("nf", { status: 404 });
  });
  // Without --no-browser, isTTY must be true to proceed; but factory and browser
  // both stub the network, so the test exercises the URL composition end-to-end.
  const exit = await runAuthLogin(
    {
      argv: ["--server-url", "https://srv", "--no-browser"],
      globalFlags: { json: false, quiet: false, verbose: false },
      env: { DOVECOTE_CLIENT_ID: "cli-test" },
      stdout: () => {},
      stderr: () => {},
      configPath: cfgPath,
      fetchImpl,
    },
    { browser, loopbackFactory: factory, isTTY: false }
  );
  expect(exit).toBe(ExitCode.OK);
});

test("auth login: no TTY and --no-browser absent → exit 4", async () => {
  const exit = await runAuthLogin(
    {
      argv: ["--server-url", "https://srv"],
      globalFlags: { json: false, quiet: false, verbose: false },
      env: { DOVECOTE_CLIENT_ID: "cli-test" },
      stdout: () => {},
      stderr: () => {},
      configPath: cfgPath,
    },
    { isTTY: false }
  );
  expect(exit).toBe(ExitCode.NOT_FOUND);
});

test("auth login: exchange 403 → exit 6", async () => {
  let capturedState: string | undefined;
  const factory: LoopbackServerFactory = async () => ({
    redirectUri: "http://127.0.0.1:54321",
    onAuthorizeUrl(url: string) {
      capturedState = new URL(url).searchParams.get("state") ?? undefined;
    },
    async waitForCallback() {
      return { code: "c", state: capturedState ?? "" };
    },
    async close() {},
  });
  const browser = async (_url: string) => {};
  const fetchImpl = makeFetch((url) => {
    if (url.includes("/token")) {
      return new Response(JSON.stringify({ access_token: "oauth_zzz" }), { status: 200 });
    }
    if (url.includes("/v1/auth/exchange")) {
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    }
    return new Response("nf", { status: 404 });
  });

  try {
    const exit = await runAuthLogin(
      {
        argv: ["--server-url", "https://srv", "--no-browser"],
        globalFlags: { json: false, quiet: false, verbose: false },
        env: { DOVECOTE_CLIENT_ID: "cli-test" },
        stdout: () => {},
        stderr: () => {},
        configPath: cfgPath,
        fetchImpl,
      },
      { browser, loopbackFactory: factory, isTTY: false }
    );
    // login throws CliError before reaching here unless exchange swallows it.
    expect(exit).toBe(ExitCode.FORBIDDEN);
  } catch (e: any) {
    expect(e.code).toBe(ExitCode.FORBIDDEN);
  }
});

test("auth login: loopback callback never arrives → exit 5", async () => {
  // Simulate a real timeout: the loopback factory rejects with a CliError
  // (matching defaultLoopbackFactory's contract).
  const { CliError, ExitCode: EC } = await import("../../src/exit-codes.ts");
  const timeoutFactory: LoopbackServerFactory = async () => ({
    redirectUri: "http://127.0.0.1:54321",
    onAuthorizeUrl() {},
    async waitForCallback(ms: number) {
      throw new CliError(EC.OAUTH_FAILED, `OAuth callback timeout after ${ms}ms`);
    },
    async close() {},
  });
  const browser = async (_url: string) => {};
  const err: string[] = [];
  try {
    const exit = await runAuthLogin(
      {
        argv: ["--server-url", "https://srv", "--no-browser"],
        globalFlags: { json: false, quiet: false, verbose: false },
        env: { DOVECOTE_CLIENT_ID: "cli-test" },
        stdout: () => {},
        stderr: (s) => err.push(s),
        configPath: cfgPath,
        fetchImpl: makeFetch(() => new Response("nf", { status: 404 })),
      },
      {
        browser,
        loopbackFactory: timeoutFactory,
        isTTY: false,
        callbackTimeoutMs: 10,
      }
    );
    expect(exit).toBe(ExitCode.OAUTH_FAILED);
  } catch (e: any) {
    expect(e.code).toBe(ExitCode.OAUTH_FAILED);
    expect(String(e.message)).toContain("timeout");
  }
});

test("auth login: config dir read-only → exit 8 to stderr", async () => {
  // Make a sub-dir read-only, then point cfgPath under it so mkdir fails EACCES.
  const lockedDir = join(tmpDir, "locked");
  await fs.mkdir(lockedDir, { recursive: true });
  await fs.chmod(lockedDir, 0o500);
  const lockedCfg = join(lockedDir, "child", "config.json");

  let capturedState: string | undefined;
  const factory: LoopbackServerFactory = async () => ({
    redirectUri: "http://127.0.0.1:54321",
    onAuthorizeUrl(url: string) {
      capturedState = new URL(url).searchParams.get("state") ?? undefined;
    },
    async waitForCallback() {
      return { code: "c", state: capturedState ?? "" };
    },
    async close() {},
  });
  const fetchImpl = makeFetch((url) => {
    if (url.includes("/token")) {
      return new Response(JSON.stringify({ access_token: "oauth_xx" }), { status: 200 });
    }
    if (url.includes("/v1/auth/exchange")) {
      return new Response(
        JSON.stringify({
          token: "dvct_x",
          tokenId: "tid_x",
          userId: "operator",
          scopes: ["dovecote:admin"],
          expiresAt: Date.now() + 90 * 86400 * 1000,
        }),
        { status: 201 }
      );
    }
    return new Response("nf", { status: 404 });
  });

  const err: string[] = [];
  try {
    const exit = await runAuthLogin(
      {
        argv: ["--server-url", "https://srv", "--no-browser"],
        globalFlags: { json: false, quiet: false, verbose: false },
        env: { DOVECOTE_CLIENT_ID: "cli-test" },
        stdout: () => {},
        stderr: (s) => err.push(s),
        configPath: lockedCfg,
        fetchImpl,
      },
      { browser: async () => {}, loopbackFactory: factory, isTTY: false }
    );
    expect(exit).toBe(ExitCode.FS_WRITE);
  } catch (e: any) {
    expect(e.code).toBe(ExitCode.FS_WRITE);
  } finally {
    // Restore so afterEach can clean up.
    try {
      await fs.chmod(lockedDir, 0o700);
    } catch {}
  }
});

test("auth logout: clears config when revoke 200", async () => {
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
  const code = await runMain({
    argv: ["auth", "logout"],
    env: { HOME: "/no" },
    stdout: () => {},
    stderr: () => {},
    configPath: cfgPath,
    fetchImpl: makeFetch(() =>
      new Response(
        JSON.stringify({ revoked: true, tokenId: "tid_a", notice: "" }),
        { status: 200 }
      )
    ),
  });
  expect(code).toBe(ExitCode.OK);
  expect(await readConfig(cfgPath)).toBeNull();
});

test("auth logout: no config → exit 3", async () => {
  const missing = join(tmpDir, "absent.json");
  const code = await runMain({
    argv: ["auth", "logout"],
    env: { HOME: "/no" },
    stdout: () => {},
    stderr: () => {},
    configPath: missing,
  });
  expect(code).toBe(ExitCode.NO_CONFIG);
});

test("auth logout: server 5xx still clears config locally, exit 7", async () => {
  await writeConfig(
    {
      serverUrl: "https://srv",
      tokens: [
        { tokenId: "tid_a", token: "dvct_a", userId: "operator", scopes: ["dovecote:notify"], expiresAt: Date.now() + 90 * 86400 * 1000 },
      ],
    },
    cfgPath
  );
  const code = await runMain({
    argv: ["auth", "logout"],
    env: { HOME: "/no" },
    stdout: () => {},
    stderr: () => {},
    configPath: cfgPath,
    fetchImpl: makeFetch(() => new Response("oops", { status: 500 })),
  });
  expect(code).toBe(ExitCode.UPSTREAM);
  expect(await readConfig(cfgPath)).toBeNull();
});

test("auth whoami: prints config + health info, exit 0", async () => {
  await writeConfig(
    {
      serverUrl: "https://srv",
      tokens: [
        { tokenId: "tid_a", token: "dvct_a", userId: "alice@example.com", scopes: ["dovecote:admin"], expiresAt: Date.now() + 90 * 86400 * 1000 },
      ],
    },
    cfgPath
  );
  const out: string[] = [];
  const { CLI_VERSION } = await import("../../src/version.ts");
  const code = await runMain({
    argv: ["auth", "whoami"],
    env: { HOME: "/no" },
    stdout: (s) => out.push(s),
    stderr: () => {},
    configPath: cfgPath,
    fetchImpl: makeFetch(() =>
      new Response(
        JSON.stringify({ status: "ok", minClientVersion: CLI_VERSION }),
        { status: 200 }
      )
    ),
  });
  expect(code).toBe(ExitCode.OK);
  // Reads from LocalToken.userId, not a hardcode.
  expect(out.join("")).toContain("alice@example.com");
  expect(out.join("")).not.toContain("userId=operator");
});

test("auth whoami: outdated config (missing userId) → exit 3 with schema notice", async () => {
  // Write a legacy-style config file without userId.
  await fs.writeFile(
    cfgPath,
    JSON.stringify({
      serverUrl: "https://srv",
      tokens: [
        {
          tokenId: "tid_legacy",
          token: "dvct_legacy",
          scopes: ["dovecote:admin"],
          expiresAt: Date.now() + 90 * 86400 * 1000,
        },
      ],
    }),
    "utf-8"
  );
  const err: string[] = [];
  const code = await runMain({
    argv: ["auth", "whoami"],
    env: { HOME: "/no" },
    stdout: () => {},
    stderr: (s) => err.push(s),
    configPath: cfgPath,
  });
  expect(code).toBe(ExitCode.NO_CONFIG);
  expect(err.join("")).toContain("schema outdated");
});

test("auth whoami: no config → exit 3", async () => {
  const missing = join(tmpDir, "absent.json");
  const code = await runMain({
    argv: ["auth", "whoami"],
    env: { HOME: "/no" },
    stdout: () => {},
    stderr: () => {},
    configPath: missing,
  });
  expect(code).toBe(ExitCode.NO_CONFIG);
});

test("auth whoami: client behind minClientVersion → exit 10", async () => {
  await writeConfig(
    {
      serverUrl: "https://srv",
      tokens: [
        { tokenId: "tid_a", token: "dvct_a", userId: "operator", scopes: ["dovecote:admin"], expiresAt: Date.now() + 90 * 86400 * 1000 },
      ],
    },
    cfgPath
  );
  const code = await runMain({
    argv: ["auth", "whoami"],
    env: { HOME: "/no" },
    stdout: () => {},
    stderr: () => {},
    configPath: cfgPath,
    fetchImpl: makeFetch(() =>
      new Response(
        JSON.stringify({ status: "ok", minClientVersion: "999.0.0" }),
        { status: 200 }
      )
    ),
  });
  expect(code).toBe(ExitCode.CLIENT_BEHIND);
});

test("auth login: --label forwards runtime token label", async () => {
  let capturedState: string | undefined;
  let exchangeBody: string | undefined;
  const factory: LoopbackServerFactory = async () => ({
    redirectUri: "http://127.0.0.1:54321",
    onAuthorizeUrl(url: string) {
      capturedState = new URL(url).searchParams.get("state") ?? undefined;
    },
    async waitForCallback() {
      return { code: "c", state: capturedState ?? "" };
    },
    async close() {},
  });
  const fetchImpl = makeFetch((url, init) => {
    if (url.includes("/token")) {
      return new Response(JSON.stringify({ access_token: "oauth_label" }), { status: 200 });
    }
    if (url.includes("/v1/auth/exchange")) {
      exchangeBody = init?.body as string | undefined;
      return new Response(
        JSON.stringify({
          token: "dvct_x",
          tokenId: "t1",
          userId: "operator",
          scopes: ["dovecote:admin"],
          expiresAt: Date.now() + 90 * 86400 * 1000,
          label: "ci-runner-1",
        }),
        { status: 201 }
      );
    }
    return new Response("nf", { status: 404 });
  });
  const out: string[] = [];

  const exit = await runAuthLogin(
    {
      argv: ["--server-url", "https://srv", "--no-browser", "--label", "ci-runner-1"],
      globalFlags: { json: false, quiet: false, verbose: false },
      env: { DOVECOTE_CLIENT_ID: "cli-test" },
      stdout: (s) => out.push(s),
      stderr: () => {},
      configPath: cfgPath,
      fetchImpl,
    },
    { browser: async () => {}, loopbackFactory: factory, isTTY: false }
  );

  expect(exit).toBe(ExitCode.OK);
  expect(JSON.parse(exchangeBody ?? "{}").label).toBe("ci-runner-1");
  expect(out.join("")).toContain("label='ci-runner-1'");
});

test("auth login: omitted --label defaults runtime token label", async () => {
  let capturedState: string | undefined;
  let exchangeBody: string | undefined;
  const factory: LoopbackServerFactory = async () => ({
    redirectUri: "http://127.0.0.1:54321",
    onAuthorizeUrl(url: string) {
      capturedState = new URL(url).searchParams.get("state") ?? undefined;
    },
    async waitForCallback() {
      return { code: "c", state: capturedState ?? "" };
    },
    async close() {},
  });
  const fetchImpl = makeFetch((url, init) => {
    if (url.includes("/token")) {
      return new Response(JSON.stringify({ access_token: "oauth_default_label" }), { status: 200 });
    }
    if (url.includes("/v1/auth/exchange")) {
      exchangeBody = init?.body as string | undefined;
      return new Response(
        JSON.stringify({
          token: "dvct_x",
          tokenId: "t1",
          userId: "operator",
          scopes: ["dovecote:admin"],
          expiresAt: Date.now() + 90 * 86400 * 1000,
          label: "dovecote-cli",
        }),
        { status: 201 }
      );
    }
    return new Response("nf", { status: 404 });
  });
  const out: string[] = [];

  const exit = await runAuthLogin(
    {
      argv: ["--server-url", "https://srv", "--no-browser"],
      globalFlags: { json: false, quiet: false, verbose: false },
      env: { DOVECOTE_CLIENT_ID: "cli-test" },
      stdout: (s) => out.push(s),
      stderr: () => {},
      configPath: cfgPath,
      fetchImpl,
    },
    { browser: async () => {}, loopbackFactory: factory, isTTY: false }
  );

  expect(exit).toBe(ExitCode.OK);
  expect(JSON.parse(exchangeBody ?? "{}").label).toBe("dovecote-cli");
  expect(out.join("")).toContain("label='dovecote-cli'");
});


test("auth login: oversized --label surfaces upstream exchange failure", async () => {
  let capturedState: string | undefined;
  const factory: LoopbackServerFactory = async () => ({
    redirectUri: "http://127.0.0.1:54321",
    onAuthorizeUrl(url: string) {
      capturedState = new URL(url).searchParams.get("state") ?? undefined;
    },
    async waitForCallback() {
      return { code: "c", state: capturedState ?? "" };
    },
    async close() {},
  });
  const fetchImpl = makeFetch((url) => {
    if (url.includes("/token")) {
      return new Response(JSON.stringify({ access_token: "oauth_long_label" }), { status: 200 });
    }
    if (url.includes("/v1/auth/exchange")) {
      return new Response(JSON.stringify({ error: "label_too_long" }), { status: 400 });
    }
    return new Response("nf", { status: 404 });
  });

  try {
    const exit = await runAuthLogin(
      {
        argv: ["--server-url", "https://srv", "--no-browser", "--label", "x".repeat(65)],
        globalFlags: { json: false, quiet: false, verbose: false },
        env: { DOVECOTE_CLIENT_ID: "cli-test" },
        stdout: () => {},
        stderr: () => {},
        configPath: cfgPath,
        fetchImpl,
      },
      { browser: async () => {}, loopbackFactory: factory, isTTY: false }
    );
    expect(exit).not.toBe(ExitCode.OK);
  } catch (e: any) {
    expect(e).toBeInstanceOf(CliError);
    expect(e.code).toBe(ExitCode.UPSTREAM);
    expect(String(e.message)).toContain("Exchange failed: 400");
  }
});

test("auth login: --help lists --label without OAuth flow", async () => {
  const out: string[] = [];
  let fetchCalls = 0;
  const exit = await runAuthLogin({
    argv: ["--help"],
    globalFlags: { json: false, quiet: false, verbose: false },
    env: {},
    stdout: (s) => out.push(s),
    stderr: () => {},
    configPath: cfgPath,
    fetchImpl: makeFetch(() => {
      fetchCalls++;
      throw new Error("fetch should not be called for auth login help");
    }),
  });

  expect(exit).toBe(ExitCode.OK);
  expect(out.join("")).toContain("--label");
  expect(out.join("")).toContain("--token");
  expect(out.join("")).toContain("login");
  expect(fetchCalls).toBe(0);
});
