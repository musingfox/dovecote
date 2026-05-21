import { test, expect } from "bun:test";
import { runMain } from "../src/main.ts";
import { ExitCode } from "../src/exit-codes.ts";

test("runMain: --version prints version", async () => {
  const out: string[] = [];
  const code = await runMain({
    argv: ["--version"],
    stdout: (s) => out.push(s),
    stderr: () => {},
  });
  expect(code).toBe(ExitCode.OK);
  expect(out.join("")).toContain("0.1.0");
});

test("runMain: 'help' command prints help text", async () => {
  const out: string[] = [];
  const code = await runMain({
    argv: ["help"],
    stdout: (s) => out.push(s),
    stderr: () => {},
  });
  expect(code).toBe(ExitCode.OK);
  expect(out.join("")).toContain("Usage:");
});

test("runMain: empty argv prints help (exit 0)", async () => {
  const out: string[] = [];
  const code = await runMain({
    argv: [],
    stdout: (s) => out.push(s),
    stderr: () => {},
  });
  expect(code).toBe(ExitCode.OK);
  expect(out.join("")).toContain("Usage:");
});

test("runMain: unknown command → exit 2", async () => {
  const err: string[] = [];
  const code = await runMain({
    argv: ["bogus"],
    stdout: () => {},
    stderr: (s) => err.push(s),
  });
  expect(code).toBe(ExitCode.USAGE);
  expect(err.join("")).toContain("Unknown command");
});

test("runMain: auth without subcommand → exit 2", async () => {
  const err: string[] = [];
  const code = await runMain({
    argv: ["auth"],
    stdout: () => {},
    stderr: (s) => err.push(s),
  });
  expect(code).toBe(ExitCode.USAGE);
  expect(err.join("")).toContain("auth subcommand");
});

test("runMain: channels without subcommand → exit 2", async () => {
  const err: string[] = [];
  const code = await runMain({
    argv: ["channels"],
    stdout: () => {},
    stderr: (s) => err.push(s),
  });
  expect(code).toBe(ExitCode.USAGE);
});

test("runMain: env without subcommand → exit 2", async () => {
  const err: string[] = [];
  const code = await runMain({
    argv: ["env"],
    stdout: () => {},
    stderr: (s) => err.push(s),
  });
  expect(code).toBe(ExitCode.USAGE);
});

test("runMain: tokens without subcommand → exit 2", async () => {
  const err: string[] = [];
  const code = await runMain({
    argv: ["tokens"],
    stdout: () => {},
    stderr: (s) => err.push(s),
  });
  expect(code).toBe(ExitCode.USAGE);
});

test("runMain: --timeout invalid → exit 2", async () => {
  const err: string[] = [];
  const code = await runMain({
    argv: ["--timeout", "abc", "ping"],
    stdout: () => {},
    stderr: (s) => err.push(s),
  });
  expect(code).toBe(ExitCode.USAGE);
});
