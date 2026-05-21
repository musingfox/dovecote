import { test, expect } from "bun:test";
import {
  performLoopbackAuthorize,
  exchangeOAuthForRuntimeToken,
  defaultLoopbackFactory,
  type LoopbackServer,
  type LoopbackServerFactory,
} from "../src/auth-flow.ts";
import { CliError, ExitCode } from "../src/exit-codes.ts";

function makeFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    return handler(url, init);
  }) as typeof fetch;
}

test("performLoopbackAuthorize: state mismatch → CliError exit 5", async () => {
  const factory: LoopbackServerFactory = async () => ({
    redirectUri: "http://127.0.0.1:54321",
    async waitForCallback() {
      return { code: "c", state: "different-state-than-what-was-sent" };
    },
    async close() {},
  });
  await expect(
    performLoopbackAuthorize({
      serverUrl: "https://srv",
      clientId: "test-client",
      scopes: ["dovecote:admin"],
      noBrowser: true,
      stderr: () => {},
      loopbackFactory: factory,
      fetchImpl: makeFetch(() => new Response("", { status: 200 })),
    })
  ).rejects.toBeInstanceOf(CliError);
});

test("performLoopbackAuthorize: /token returns non-2xx → CliError exit 5", async () => {
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
  await expect(
    performLoopbackAuthorize({
      serverUrl: "https://srv",
      clientId: "test-client",
      scopes: ["dovecote:admin"],
      noBrowser: true,
      stderr: () => {},
      loopbackFactory: factory,
      fetchImpl: makeFetch(() => new Response("server error", { status: 500 })),
    })
  ).rejects.toBeInstanceOf(CliError);
});

test("performLoopbackAuthorize: token endpoint returns no access_token → CliError", async () => {
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
  await expect(
    performLoopbackAuthorize({
      serverUrl: "https://srv",
      clientId: "test-client",
      scopes: ["dovecote:admin"],
      noBrowser: true,
      stderr: () => {},
      loopbackFactory: factory,
      fetchImpl: makeFetch(() =>
        new Response(JSON.stringify({}), { status: 200 })
      ),
    })
  ).rejects.toBeInstanceOf(CliError);
});

test("performLoopbackAuthorize: browser thrown → swallowed, still proceeds", async () => {
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
  const stderr: string[] = [];
  const tok = await performLoopbackAuthorize({
    serverUrl: "https://srv",
    clientId: "test-client",
    scopes: ["dovecote:admin"],
    noBrowser: false,
    stderr: (s) => stderr.push(s),
    loopbackFactory: factory,
    browser: async () => {
      throw new Error("no display");
    },
    fetchImpl: makeFetch(
      () => new Response(JSON.stringify({ access_token: "t" }), { status: 200 })
    ),
  });
  expect(tok).toBe("t");
  expect(stderr.join("")).toContain("Failed to open browser");
});

test("performLoopbackAuthorize: nothing provided for browser → prints URL", async () => {
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
  const stderr: string[] = [];
  await performLoopbackAuthorize({
    serverUrl: "https://srv",
    clientId: "test-client",
    scopes: ["dovecote:admin"],
    noBrowser: false,
    stderr: (s) => stderr.push(s),
    loopbackFactory: factory,
    // no browser passed
    fetchImpl: makeFetch(
      () => new Response(JSON.stringify({ access_token: "t" }), { status: 200 })
    ),
  });
  expect(stderr.join("")).toContain("Open this URL");
});

test("exchangeOAuthForRuntimeToken: 5xx → CliError exit 7", async () => {
  await expect(
    exchangeOAuthForRuntimeToken({
      serverUrl: "https://srv",
      oauthToken: "x",
      fetchImpl: makeFetch(() => new Response("oops", { status: 503 })),
    })
  ).rejects.toBeInstanceOf(CliError);
});

test("exchangeOAuthForRuntimeToken: 403 → CliError exit 6", async () => {
  try {
    await exchangeOAuthForRuntimeToken({
      serverUrl: "https://srv",
      oauthToken: "x",
      fetchImpl: makeFetch(() =>
        new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })
      ),
    });
    throw new Error("expected throw");
  } catch (e: any) {
    expect(e.code).toBe(ExitCode.FORBIDDEN);
  }
});

test("exchangeOAuthForRuntimeToken: 400 (other) → CliError generic", async () => {
  try {
    await exchangeOAuthForRuntimeToken({
      serverUrl: "https://srv",
      oauthToken: "x",
      fetchImpl: makeFetch(() =>
        new Response(JSON.stringify({ error: "invalid_request" }), { status: 400 })
      ),
    });
    throw new Error("expected throw");
  } catch (e: any) {
    expect(e).toBeInstanceOf(CliError);
  }
});

test("exchangeOAuthForRuntimeToken: forwards label and expiresIn in body", async () => {
  let capturedBody = "";
  await exchangeOAuthForRuntimeToken({
    serverUrl: "https://srv",
    oauthToken: "x",
    label: "ci",
    expiresIn: "7d",
    fetchImpl: makeFetch((_url, init) => {
      capturedBody = (init?.body as string) ?? "";
      return new Response(
        JSON.stringify({
          token: "dvct_x",
          tokenId: "t1",
          userId: "operator",
          scopes: ["dovecote:admin"],
          expiresAt: 1,
          label: "ci",
        }),
        { status: 201 }
      );
    }),
  });
  const parsed = JSON.parse(capturedBody);
  expect(parsed.label).toBe("ci");
  expect(parsed.expiresIn).toBe("7d");
});

test("defaultLoopbackFactory creates a real loopback server (smoke)", async () => {
  const server: LoopbackServer = await defaultLoopbackFactory();
  try {
    expect(server.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    await server.close();
  }
});

test("defaultLoopbackFactory waitForCallback times out", async () => {
  const server = await defaultLoopbackFactory();
  await expect(server.waitForCallback(50)).rejects.toBeInstanceOf(CliError);
});

test("defaultLoopbackFactory: GET to it resolves with code/state", async () => {
  const server = await defaultLoopbackFactory();
  try {
    const pending = server.waitForCallback(5000);
    // Hit the loopback endpoint
    await fetch(`${server.redirectUri}/cb?code=abc&state=xyz`);
    const cb = await pending;
    expect(cb.code).toBe("abc");
    expect(cb.state).toBe("xyz");
  } finally {
    await server.close();
  }
});
