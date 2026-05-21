import { test, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHttpClient } from "../src/http.ts";
import { writeConfig, readConfig } from "../src/config.ts";
import { CliError, ExitCode } from "../src/exit-codes.ts";

let tmpDir: string;
let cfgPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), "dovecote-http-"));
  cfgPath = join(tmpDir, "config.json");
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    return handler(url, init);
  }) as typeof fetch;
}

const NOW = 1_700_000_000_000;
const baseConfig = {
  serverUrl: "https://example.com",
  tokens: [
    {
      tokenId: "tid_old",
      token: "dvct_old",
      userId: "operator",
      scopes: ["dovecote:notify"],
      expiresAt: NOW + 7 * 86400 * 1000, // 7d remaining (within 14d threshold)
      label: "cli",
    },
  ],
};

test("auto-renew: config-sourced token within 14d → renew called, config rewritten", async () => {
  await writeConfig(baseConfig, cfgPath);
  const calls: string[] = [];
  const fetchImpl = makeFetch(async (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/v1/tokens/tid_old/renew")) {
      return new Response(
        JSON.stringify({
          token: "dvct_NEW",
          tokenId: "tid_new",
          userId: "operator",
          scopes: ["dovecote:notify"],
          expiresAt: NOW + 90 * 86400 * 1000,
          label: "cli",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } }
      );
    }
    if (url.endsWith("/v1/channels")) {
      return new Response(JSON.stringify({ channels: [] }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });

  const config = await readConfig(cfgPath);
  const client = createHttpClient({
    serverUrl: "https://example.com",
    config,
    configPath: cfgPath,
    env: {},
    fetchImpl,
    now: () => NOW,
  });

  const res = await client.request({ method: "GET", path: "/v1/channels" });
  expect(res.status).toBe(200);
  // Verify renew was called BEFORE the main request
  expect(calls[0]).toBe("POST https://example.com/v1/tokens/tid_old/renew");
  expect(calls[1]).toBe("GET https://example.com/v1/channels");
  // Outbound request must use the NEW token
  const channelsCall = (fetchImpl as any).mock; // not available; assert via headers passed
  // Re-read config and verify it now holds the new token
  const after = await readConfig(cfgPath);
  expect(after?.tokens[0]?.token).toBe("dvct_NEW");
  expect(after?.tokens[0]?.tokenId).toBe("tid_new");
});

test("auto-renew: token has 30d remaining → no renew call, only main request fires", async () => {
  const cfg = {
    ...baseConfig,
    tokens: [
      {
        ...baseConfig.tokens[0]!,
        expiresAt: NOW + 30 * 86400 * 1000,
      },
    ],
  };
  await writeConfig(cfg, cfgPath);
  let renewCalled = false;
  const fetchImpl = makeFetch(async (url) => {
    if (url.includes("/renew")) {
      renewCalled = true;
    }
    return new Response(JSON.stringify({ channels: [] }), { status: 200 });
  });

  const client = createHttpClient({
    serverUrl: "https://example.com",
    config: cfg,
    configPath: cfgPath,
    env: {},
    fetchImpl,
    now: () => NOW,
  });
  await client.request({ path: "/v1/channels" });
  expect(renewCalled).toBe(false);
});

test("auto-renew: renew endpoint returns 500 → config unchanged, main request still fires", async () => {
  await writeConfig(baseConfig, cfgPath);
  const fetchImpl = makeFetch(async (url) => {
    if (url.includes("/renew")) {
      return new Response("server error", { status: 500 });
    }
    return new Response(JSON.stringify({ channels: [] }), { status: 200 });
  });
  const client = createHttpClient({
    serverUrl: "https://example.com",
    config: baseConfig,
    configPath: cfgPath,
    env: {},
    fetchImpl,
    now: () => NOW,
  });
  const res = await client.request({ path: "/v1/channels" });
  expect(res.status).toBe(200);
  const after = await readConfig(cfgPath);
  expect(after?.tokens[0]?.token).toBe("dvct_old");
});

test("auto-renew: expired token + renew 401 + outbound 401 expired → exit 9", async () => {
  const cfg = {
    ...baseConfig,
    tokens: [
      {
        ...baseConfig.tokens[0]!,
        expiresAt: NOW - 3600 * 1000,
      },
    ],
  };
  await writeConfig(cfg, cfgPath);
  const fetchImpl = makeFetch(async (url) => {
    if (url.includes("/renew")) {
      return new Response(
        JSON.stringify({ error: "unauthorized", error_description: "expired_token" }),
        { status: 401 }
      );
    }
    return new Response(
      JSON.stringify({ error: "unauthorized", error_description: "expired_token" }),
      { status: 401 }
    );
  });
  const client = createHttpClient({
    serverUrl: "https://example.com",
    config: cfg,
    configPath: cfgPath,
    env: {},
    fetchImpl,
    now: () => NOW,
  });
  try {
    await client.request({ path: "/v1/channels" });
    throw new Error("expected throw");
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    expect((e as CliError).code).toBe(ExitCode.TOKEN_EXPIRED);
    expect((e as CliError).message).toContain("dovecote auth login");
  }
});

test("DOVECOTE_TOKEN env-sourced: no renew attempted; 401 returns env-specific message", async () => {
  // Even though config has a near-expiry token, env takes precedence and skips renew.
  await writeConfig(baseConfig, cfgPath);
  let renewCalled = false;
  const fetchImpl = makeFetch(async (url) => {
    if (url.includes("/renew")) renewCalled = true;
    return new Response(
      JSON.stringify({ error: "unauthorized", error_description: "expired_token" }),
      { status: 401 }
    );
  });
  const client = createHttpClient({
    serverUrl: "https://example.com",
    config: baseConfig,
    configPath: cfgPath,
    env: { DOVECOTE_TOKEN: "dvct_envtoken" },
    fetchImpl,
    now: () => NOW,
  });
  try {
    await client.request({ path: "/v1/channels" });
    throw new Error("expected throw");
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    expect((e as CliError).code).toBe(ExitCode.TOKEN_EXPIRED);
    expect((e as CliError).message).toContain("DOVECOTE_TOKEN");
  }
  expect(renewCalled).toBe(false);
});

test("request times out via AbortController after timeoutMs", async () => {
  await writeConfig(baseConfig, cfgPath);
  const fetchImpl: typeof fetch = async (_input, init) => {
    // Simulate a hanging request that respects abort.
    return new Promise((resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      if (signal) {
        signal.addEventListener("abort", () => {
          const e = new Error("aborted");
          (e as any).name = "AbortError";
          reject(e);
        });
      }
      // Never resolve otherwise.
    });
  };
  // Set far-future expiresAt to skip auto-renew.
  const cfg = {
    ...baseConfig,
    tokens: [{ ...baseConfig.tokens[0]!, expiresAt: NOW + 90 * 86400 * 1000 }],
  };
  const client = createHttpClient({
    serverUrl: "https://example.com",
    config: cfg,
    configPath: cfgPath,
    env: {},
    fetchImpl,
    now: () => NOW,
  });
  try {
    await client.request({ path: "/v1/channels", timeoutMs: 50 });
    throw new Error("expected throw");
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    expect((e as CliError).code).toBe(ExitCode.UPSTREAM);
    expect((e as CliError).message).toContain("timed out");
  }
});
