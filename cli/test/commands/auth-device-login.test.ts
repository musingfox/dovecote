import { test, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "../../src/exit-codes.ts";
import { runMain } from "../../src/main.ts";
import { runAuthLogin } from "../../src/commands/auth/login.ts";

let tmpDir: string;
let cfgPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), "dovecote-device-removed-"));
  cfgPath = join(tmpDir, "config.json");
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("device flag removed: --device yields USAGE with unknown option in stderr", async () => {
  const err: string[] = [];
  const code = await runMain({
    argv: ["auth", "login", "--device"],
    env: { HOME: "/no", DOVECOTE_CLIENT_ID: "x" },
    stdout: () => {},
    stderr: (s) => err.push(s),
    configPath: cfgPath,
  });
  expect(code).toBe(ExitCode.USAGE);
  expect(err.join("")).toMatch(/unknown option/i);
});

test("--help documents --token and does not mention --device", async () => {
  const out: string[] = [];
  const code = await runAuthLogin(
    {
      argv: ["--help"],
      globalFlags: { json: false, quiet: false, verbose: false },
      env: {},
      stdout: (s) => out.push(s),
      stderr: () => {},
      configPath: cfgPath,
    }
  );
  expect(code).toBe(ExitCode.OK);
  const help = out.join("");
  expect(help).toContain("--token");
  expect(help).not.toContain("--device");
});
