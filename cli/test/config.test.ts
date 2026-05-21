import { test, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configPath,
  readConfig,
  writeConfig,
  clearConfig,
  resolveActiveToken,
  resolveServerUrl,
} from "../src/config.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), "dovecote-cfg-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("configPath honors XDG_CONFIG_HOME", () => {
  const p = configPath({ XDG_CONFIG_HOME: "/custom/path" } as any);
  expect(p).toBe("/custom/path/dovecote/config.json");
});

test("configPath falls back to $HOME/.config", () => {
  const p = configPath({ HOME: "/home/x" } as any);
  expect(p.endsWith("/.config/dovecote/config.json") || p.includes("dovecote/config.json")).toBe(true);
});

test("readConfig returns null when no file exists", async () => {
  const p = join(tmpDir, "missing.json");
  expect(await readConfig(p)).toBeNull();
});

test("writeConfig then readConfig roundtrip with 0600 perms", async () => {
  const p = join(tmpDir, "sub", "config.json");
  await writeConfig(
    {
      serverUrl: "https://example.com",
      tokens: [
        {
          tokenId: "tid_x",
          token: "dvct_test",
          userId: "operator",
          scopes: ["dovecote:notify"],
          expiresAt: 1_700_000_000_000,
          label: "ci",
        },
      ],
    },
    p
  );
  const read = await readConfig(p);
  expect(read?.tokens[0]?.tokenId).toBe("tid_x");
  const stat = await fs.stat(p);
  // mode 0600 — owner rw only
  expect(stat.mode & 0o777).toBe(0o600);
});

test("clearConfig is idempotent", async () => {
  const p = join(tmpDir, "config.json");
  await clearConfig(p); // no error when absent
  await writeConfig({ serverUrl: "x", tokens: [] }, p);
  await clearConfig(p);
  expect(await readConfig(p)).toBeNull();
});

test("resolveActiveToken prefers DOVECOTE_TOKEN env over config", () => {
  const cfg = {
    serverUrl: "s",
    tokens: [
      {
        tokenId: "tid_x",
        token: "dvct_cfg",
        userId: "operator",
        scopes: ["dovecote:notify"],
        expiresAt: 1,
      },
    ],
  };
  const fromEnv = resolveActiveToken(cfg, { DOVECOTE_TOKEN: "dvct_env" } as any);
  expect(fromEnv?.token).toBe("dvct_env");
  expect(fromEnv?.source).toBe("env");
  const fromCfg = resolveActiveToken(cfg, {} as any);
  expect(fromCfg?.token).toBe("dvct_cfg");
  expect(fromCfg?.source).toBe("config");
  const none = resolveActiveToken(null, {} as any);
  expect(none).toBeNull();
});

test("resolveServerUrl honors DOVECOTE_SERVER_URL > config > default", () => {
  expect(
    resolveServerUrl({ serverUrl: "s", tokens: [] }, { DOVECOTE_SERVER_URL: "https://env" } as any)
  ).toBe("https://env");
  expect(resolveServerUrl({ serverUrl: "https://cfg", tokens: [] }, {} as any)).toBe(
    "https://cfg"
  );
  expect(resolveServerUrl(null, {} as any)).toContain("https://");
});
