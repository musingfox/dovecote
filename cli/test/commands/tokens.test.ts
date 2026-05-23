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

// ============================================================
// tokens list --remote / --all / --user  (Phase 4.3 / C-CLI-RemoteList)
// ============================================================

test("tokens list --remote prints expected format from stub fetch", async () => {
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
  let capturedUrl = "";
  const out: string[] = [];
  const code = await runMain({
    argv: ["tokens", "list", "--remote"],
    env: { HOME: "/no" },
    stdout: (s) => out.push(s),
    stderr: () => {},
    configPath: cfgPath,
    fetchImpl: makeFetch((url) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          tokens: [
            {
              tokenId: "tid_remote",
              userId: "alice",
              scopes: ["dovecote:notify"],
              createdAt: 1_700_000_000_000,
              expiresAt: 1_800_000_000_000,
              label: "ci",
            },
          ],
          truncated: false,
        }),
        { status: 200 }
      );
    }),
  });
  expect(code).toBe(ExitCode.OK);
  expect(capturedUrl).toBe("https://srv/v1/tokens");
  const joined = out.join("");
  expect(joined).toContain("tid_remote");
  expect(joined).toContain("alice");
  expect(joined).toContain("ci");
});

test("tokens list --remote --json emits JSON", async () => {
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
  const out: string[] = [];
  const code = await runMain({
    argv: ["tokens", "list", "--remote", "--json"],
    env: { HOME: "/no" },
    stdout: (s) => out.push(s),
    stderr: () => {},
    configPath: cfgPath,
    fetchImpl: makeFetch(() =>
      new Response(
        JSON.stringify({
          tokens: [
            {
              tokenId: "tid_remote",
              userId: "alice",
              scopes: ["dovecote:notify"],
              createdAt: 1,
              expiresAt: 2,
            },
          ],
          truncated: false,
        }),
        { status: 200 }
      )
    ),
  });
  expect(code).toBe(ExitCode.OK);
  const parsed = JSON.parse(out.join(""));
  expect(Array.isArray(parsed)).toBe(true);
  expect(parsed[0].tokenId).toBe("tid_remote");
});

test("tokens list --remote --user=bob hits ?userId=bob", async () => {
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
  let capturedUrl = "";
  const code = await runMain({
    argv: ["tokens", "list", "--remote", "--user=bob"],
    env: { HOME: "/no" },
    stdout: () => {},
    stderr: () => {},
    configPath: cfgPath,
    fetchImpl: makeFetch((url) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ tokens: [], truncated: false }),
        { status: 200 }
      );
    }),
  });
  expect(code).toBe(ExitCode.OK);
  expect(capturedUrl).toBe("https://srv/v1/tokens?userId=bob");
});

test("tokens list --remote --all --user=bob → USAGE, no fetch", async () => {
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
  let called = false;
  const code = await runMain({
    argv: ["tokens", "list", "--remote", "--all", "--user=bob"],
    env: { HOME: "/no" },
    stdout: () => {},
    stderr: () => {},
    configPath: cfgPath,
    fetchImpl: makeFetch(() => {
      called = true;
      return new Response("{}", { status: 200 });
    }),
  });
  expect(code).toBe(ExitCode.USAGE);
  expect(called).toBe(false);
});

test("tokens list --user=bob (without --remote) → USAGE", async () => {
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
    argv: ["tokens", "list", "--user=bob"],
    env: { HOME: "/no" },
    stdout: () => {},
    stderr: () => {},
    configPath: cfgPath,
  });
  expect(code).toBe(ExitCode.USAGE);
});

test("tokens list --remote stub 403 → FORBIDDEN exit", async () => {
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
    argv: ["tokens", "list", "--remote", "--user=bob"],
    env: { HOME: "/no" },
    stdout: () => {},
    stderr: () => {},
    configPath: cfgPath,
    fetchImpl: makeFetch(() =>
      new Response(
        JSON.stringify({ error: "forbidden", error_description: "nope" }),
        { status: 403 }
      )
    ),
  });
  expect(code).toBe(ExitCode.FORBIDDEN);
});

test("tokens list --remote truncated:true → stderr warning", async () => {
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
  const err: string[] = [];
  const code = await runMain({
    argv: ["tokens", "list", "--remote", "--json"],
    env: { HOME: "/no" },
    stdout: () => {},
    stderr: (s) => err.push(s),
    configPath: cfgPath,
    fetchImpl: makeFetch(() =>
      new Response(
        JSON.stringify({
          tokens: [
            {
              tokenId: "t",
              userId: "u",
              scopes: [],
              createdAt: 1,
              expiresAt: 2,
            },
          ],
          truncated: true,
        }),
        { status: 200 }
      )
    ),
  });
  expect(code).toBe(ExitCode.OK);
  expect(err.join("")).toContain("truncated");
});
