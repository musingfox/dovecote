import { test, expect } from "bun:test";
import { runMain } from "../../src/main.ts";
import { ExitCode } from "../../src/exit-codes.ts";
import { CLI_VERSION } from "../../src/version.ts";

function makeFetch(handler: (url: string) => Response): typeof fetch {
  return (async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    return handler(url);
  }) as typeof fetch;
}

test("ping returns OK on /health success with matching version", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMain({
    argv: ["ping", "--server-url", "https://srv"],
    env: { HOME: "/no/such" },
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    fetchImpl: makeFetch((url) => {
      if (url === "https://srv/health") {
        return new Response(
          JSON.stringify({ status: "ok", minClientVersion: CLI_VERSION }),
          { status: 200 }
        );
      }
      return new Response("nope", { status: 500 });
    }),
  });
  expect(code).toBe(ExitCode.OK);
  expect(out.join("")).toContain("OK:");
});

test("ping returns exit 10 when CLI version is behind minClientVersion", async () => {
  const err: string[] = [];
  const code = await runMain({
    argv: ["ping", "--server-url", "https://srv"],
    env: { HOME: "/no/such" },
    stdout: () => {},
    stderr: (s) => err.push(s),
    fetchImpl: makeFetch(() =>
      new Response(
        JSON.stringify({ status: "ok", minClientVersion: "999.0.0" }),
        { status: 200 }
      )
    ),
  });
  expect(code).toBe(ExitCode.CLIENT_BEHIND);
  expect(err.join("")).toContain("behind");
});

test("ping returns exit 7 when /health is 5xx", async () => {
  const code = await runMain({
    argv: ["ping", "--server-url", "https://srv"],
    env: { HOME: "/no/such" },
    stdout: () => {},
    stderr: () => {},
    fetchImpl: makeFetch(() => new Response("oops", { status: 503 })),
  });
  expect(code).toBe(ExitCode.UPSTREAM);
});
