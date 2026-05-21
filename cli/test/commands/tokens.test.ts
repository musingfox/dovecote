import { test, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMain } from "../../src/main.ts";
import { ExitCode } from "../../src/exit-codes.ts";
import { writeConfig, readConfig } from "../../src/config.ts";

let tmpDir: string;
let cfgPath: string;

const futureExpiry = () => Date.now() + 90 * 86400 * 1000;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), "dovecote-tokens-"));
  cfgPath = join(tmpDir, "config.json");
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

test("tokens create posts and prints JSON", async () => {
  await writeConfig(
    {
      serverUrl: "https://srv",
      tokens: [
        { tokenId: "tid_a", token: "dvct_a", userId: "operator", scopes: ["dovecote:admin"], expiresAt: futureExpiry() },
      ],
    },
    cfgPath
  );
  const out: string[] = [];
  const code = await runMain({
    argv: [
      "tokens",
      "create",
      "--scope",
      "dovecote:notify",
      "--expires",
      "7d",
      "--label",
      "downstream",
    ],
    env: { HOME: "/no" },
    stdout: (s) => out.push(s),
    stderr: () => {},
    configPath: cfgPath,
    fetchImpl: makeFetch(() =>
      new Response(
        JSON.stringify({
          token: "dvct_new",
          tokenId: "tid_new",
          scopes: ["dovecote:notify"],
          expiresAt: futureExpiry(),
          label: "downstream",
        }),
        { status: 201 }
      )
    ),
  });
  expect(code).toBe(ExitCode.OK);
  expect(out.join("")).toContain("dvct_new");
  // Local config must be unchanged
  const after = await readConfig(cfgPath);
  expect(after?.tokens[0]?.tokenId).toBe("tid_a");
});

test("tokens create exit 2 when no --scope", async () => {
  await writeConfig(
    {
      serverUrl: "https://srv",
      tokens: [
        { tokenId: "tid_a", token: "dvct_a", userId: "operator", scopes: ["dovecote:admin"], expiresAt: futureExpiry() },
      ],
    },
    cfgPath
  );
  const code = await runMain({
    argv: ["tokens", "create"],
    env: { HOME: "/no" },
    stdout: () => {},
    stderr: () => {},
    configPath: cfgPath,
  });
  expect(code).toBe(ExitCode.USAGE);
});

test("tokens list shows one row, exit 0", async () => {
  await writeConfig(
    {
      serverUrl: "https://srv",
      tokens: [
        {
          tokenId: "tid_a",
          token: "dvct_a",
          userId: "operator",
          scopes: ["dovecote:notify"],
          expiresAt: 1_700_000_000_000,
          label: "cli",
        },
      ],
    },
    cfgPath
  );
  const out: string[] = [];
  const code = await runMain({
    argv: ["tokens", "list"],
    env: { HOME: "/no" },
    stdout: (s) => out.push(s),
    stderr: () => {},
    configPath: cfgPath,
  });
  expect(code).toBe(ExitCode.OK);
  expect(out.join("")).toContain("tid_a");
  expect(out.join("")).toContain("cli");
});

test("tokens list says 'No local tokens' on empty array", async () => {
  await writeConfig({ serverUrl: "https://srv", tokens: [] }, cfgPath);
  const out: string[] = [];
  const code = await runMain({
    argv: ["tokens", "list"],
    env: { HOME: "/no" },
    stdout: (s) => out.push(s),
    stderr: () => {},
    configPath: cfgPath,
  });
  expect(code).toBe(ExitCode.OK);
  expect(out.join("")).toContain("No local tokens");
});

test("tokens list exit 3 when no config file at all", async () => {
  const missing = join(tmpDir, "absent.json");
  const code = await runMain({
    argv: ["tokens", "list"],
    env: { HOME: "/no" },
    stdout: () => {},
    stderr: () => {},
    configPath: missing,
  });
  expect(code).toBe(ExitCode.NO_CONFIG);
});

test("tokens revoke matching local id → clears config", async () => {
  await writeConfig(
    {
      serverUrl: "https://srv",
      tokens: [
        {
          tokenId: "tid_a",
          token: "dvct_a",
          userId: "operator",
          scopes: ["dovecote:notify"],
          expiresAt: futureExpiry(),
        },
      ],
    },
    cfgPath
  );
  const code = await runMain({
    argv: ["tokens", "revoke", "tid_a"],
    env: { HOME: "/no" },
    stdout: () => {},
    stderr: () => {},
    configPath: cfgPath,
    fetchImpl: makeFetch(() =>
      new Response(
        JSON.stringify({ revoked: true, tokenId: "tid_a", notice: "ok" }),
        { status: 200 }
      )
    ),
  });
  expect(code).toBe(ExitCode.OK);
  expect(await readConfig(cfgPath)).toBeNull();
});

test("tokens revoke non-matching id → leaves local config alone", async () => {
  await writeConfig(
    {
      serverUrl: "https://srv",
      tokens: [
        {
          tokenId: "tid_a",
          token: "dvct_a",
          userId: "operator",
          scopes: ["dovecote:admin"],
          expiresAt: futureExpiry(),
        },
      ],
    },
    cfgPath
  );
  const code = await runMain({
    argv: ["tokens", "revoke", "tid_other"],
    env: { HOME: "/no" },
    stdout: () => {},
    stderr: () => {},
    configPath: cfgPath,
    fetchImpl: makeFetch(() =>
      new Response(
        JSON.stringify({ revoked: true, tokenId: "tid_other", notice: "ok" }),
        { status: 200 }
      )
    ),
  });
  expect(code).toBe(ExitCode.OK);
  const after = await readConfig(cfgPath);
  expect(after?.tokens[0]?.tokenId).toBe("tid_a");
});

test("tokens create 400 invalid_scope → exit 6 (forbidden family)", async () => {
  await writeConfig(
    {
      serverUrl: "https://srv",
      tokens: [
        { tokenId: "tid_a", token: "dvct_a", userId: "operator", scopes: ["dovecote:admin"], expiresAt: futureExpiry() },
      ],
    },
    cfgPath
  );
  const err: string[] = [];
  const code = await runMain({
    argv: ["tokens", "create", "--scope", "dovecote:bogus"],
    env: { HOME: "/no" },
    stdout: () => {},
    stderr: (s) => err.push(s),
    configPath: cfgPath,
    fetchImpl: makeFetch(
      () =>
        new Response(
          JSON.stringify({
            error: "invalid_request",
            error_description: "invalid_scope",
          }),
          { status: 400 }
        )
    ),
  });
  expect(code).toBe(ExitCode.FORBIDDEN);
  expect(err.join("")).toContain("invalid_scope");
});

test("tokens create 400 generic → exit 2 (usage)", async () => {
  await writeConfig(
    {
      serverUrl: "https://srv",
      tokens: [
        { tokenId: "tid_a", token: "dvct_a", userId: "operator", scopes: ["dovecote:admin"], expiresAt: futureExpiry() },
      ],
    },
    cfgPath
  );
  const err: string[] = [];
  const code = await runMain({
    argv: ["tokens", "create", "--scope", "dovecote:notify"],
    env: { HOME: "/no" },
    stdout: () => {},
    stderr: (s) => err.push(s),
    configPath: cfgPath,
    fetchImpl: makeFetch(
      () =>
        new Response(
          JSON.stringify({
            error: "invalid_request",
            error_description: "label too long",
          }),
          { status: 400 }
        )
    ),
  });
  expect(code).toBe(ExitCode.USAGE);
  expect(err.join("")).toContain("label too long");
});

test("tokens revoke 403 → exit 6", async () => {
  await writeConfig(
    {
      serverUrl: "https://srv",
      tokens: [
        { tokenId: "tid_a", token: "dvct_a", userId: "operator", scopes: ["dovecote:notify"], expiresAt: futureExpiry() },
      ],
    },
    cfgPath
  );
  const code = await runMain({
    argv: ["tokens", "revoke", "tid_other"],
    env: { HOME: "/no" },
    stdout: () => {},
    stderr: () => {},
    configPath: cfgPath,
    fetchImpl: makeFetch(() =>
      new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })
    ),
  });
  expect(code).toBe(ExitCode.FORBIDDEN);
});
