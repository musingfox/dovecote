import { test, expect } from "bun:test";
import { extractGlobalFlags, parseTopLevel, parseCommandArgs } from "../src/argv.ts";
import { CliError, ExitCode } from "../src/exit-codes.ts";

test("extractGlobalFlags pulls --json/--quiet/--verbose/--timeout out of argv", () => {
  const { global, remaining } = extractGlobalFlags([
    "notify",
    "ops",
    "--text",
    "hi",
    "--json",
    "--verbose",
    "--timeout",
    "5000",
  ]);
  expect(global.json).toBe(true);
  expect(global.verbose).toBe(true);
  expect(global.timeout).toBe(5000);
  expect(remaining).toEqual(["notify", "ops", "--text", "hi"]);
});

test("extractGlobalFlags supports --timeout=ms form", () => {
  const { global } = extractGlobalFlags(["ping", "--timeout=1234"]);
  expect(global.timeout).toBe(1234);
});

test("extractGlobalFlags rejects negative timeout", () => {
  expect(() => extractGlobalFlags(["--timeout=-5"])).toThrow();
});

test("parseTopLevel routes two-word commands", () => {
  const r = parseTopLevel(["auth", "login", "--client-id", "abc"]);
  expect(r.command).toBe("auth");
  expect(r.subcommand).toBe("login");
  expect(r.rest).toEqual(["--client-id", "abc"]);
});

test("parseTopLevel returns help when argv is empty", () => {
  expect(parseTopLevel([]).command).toBe("help");
});

test("parseCommandArgs handles boolean and string options", () => {
  const r = parseCommandArgs(["--text", "hello", "--dry-run", "ops"], {
    text: { type: "string" },
    "dry-run": { type: "boolean" },
  });
  expect(r.values.text).toBe("hello");
  expect(r.values["dry-run"]).toBe(true);
  expect(r.positionals).toEqual(["ops"]);
});

test("parseCommandArgs wraps node:util errors in CliError(USAGE)", () => {
  try {
    parseCommandArgs(["--unknown"], {});
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    expect((e as CliError).code).toBe(ExitCode.USAGE);
  }
});
