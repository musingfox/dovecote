import { test, expect } from "bun:test";
import { runBackfill } from "../../scripts/backfill-apitoken-user-index.mjs";

type ExecResult = { stdout: string; stderr: string; exitCode: number };
type ExecCall = { cmd: string; args: string[] };

function makeStubExec(handler: (cmd: string, args: string[]) => ExecResult) {
  const calls: ExecCall[] = [];
  const exec = async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return handler(cmd, args);
  };
  return { exec, calls };
}

function captureStdout() {
  const buf: string[] = [];
  return { fn: (s: string) => buf.push(s), value: () => buf.join("") };
}

test("backfill --dry-run with 3 canonical keys → wouldWrite:3, written:0, no put calls", async () => {
  const listOut = JSON.stringify([
    { name: "apitoken:tid_1" },
    { name: "apitoken:tid_2" },
    { name: "apitoken:tid_3" },
    { name: "apitoken_hash:abc" }, // must be filtered out
    { name: "apitoken_user:alice:tid_1" }, // must be filtered out
  ]);
  const stub = makeStubExec((cmd, args) => {
    if (args[0] === "kv" && args[1] === "key" && args[2] === "list") {
      return { stdout: listOut, stderr: "", exitCode: 0 };
    }
    if (args[0] === "kv" && args[1] === "key" && args[2] === "get") {
      const key = args[args.length - 1]!;
      const tokenId = key.slice("apitoken:".length);
      return {
        stdout: JSON.stringify({
          tokenId,
          userId: "alice",
          scopes: [],
          hash: "h",
          createdAt: 1,
          expiresAt: 2,
        }),
        stderr: "",
        exitCode: 0,
      };
    }
    return { stdout: "", stderr: "no", exitCode: 1 };
  });
  const out = captureStdout();
  const err = captureStdout();
  const code = await runBackfill({
    exec: stub.exec,
    argv: ["--dry-run"],
    stdout: out.fn,
    stderr: err.fn,
  });
  expect(code).toBe(0);
  const summary = JSON.parse(out.value().trim());
  expect(summary.scanned).toBe(3);
  expect(summary.wouldWrite).toBe(3);
  expect(summary.written).toBe(0);
  expect(summary.errored).toBe(0);
  // No put calls in dry-run
  const putCalls = stub.calls.filter((c) => c.args[2] === "put");
  expect(putCalls.length).toBe(0);
});

test("backfill --apply writes index keys; rerun is idempotent (puts again, but no double-count)", async () => {
  const listOut = JSON.stringify([
    { name: "apitoken:tid_1" },
    { name: "apitoken:tid_2" },
    { name: "apitoken:tid_3" },
  ]);
  const stub = makeStubExec((cmd, args) => {
    if (args[2] === "list") {
      return { stdout: listOut, stderr: "", exitCode: 0 };
    }
    if (args[2] === "get") {
      const key = args[args.length - 1]!;
      const tokenId = key.slice("apitoken:".length);
      return {
        stdout: JSON.stringify({ tokenId, userId: "alice", scopes: [], hash: "h" }),
        stderr: "",
        exitCode: 0,
      };
    }
    if (args[2] === "put") {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "no", exitCode: 1 };
  });
  const out = captureStdout();
  const code1 = await runBackfill({
    exec: stub.exec,
    argv: ["--apply"],
    stdout: out.fn,
    stderr: () => {},
  });
  expect(code1).toBe(0);
  const summary1 = JSON.parse(out.value().trim().split("\n").pop()!);
  expect(summary1.written).toBe(3);
  expect(summary1.wouldWrite).toBe(0);

  // Idempotent rerun — write count is again 3 but operations are no-op on KV
  // (writing the same empty value to the same key).
  const code2 = await runBackfill({
    exec: stub.exec,
    argv: ["--apply"],
    stdout: out.fn,
    stderr: () => {},
  });
  expect(code2).toBe(0);
});

test("backfill: get returns invalid JSON → errored increments, exit 0", async () => {
  const listOut = JSON.stringify([{ name: "apitoken:tid_bad" }]);
  const stub = makeStubExec((cmd, args) => {
    if (args[2] === "list") return { stdout: listOut, stderr: "", exitCode: 0 };
    if (args[2] === "get") return { stdout: "not json", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 1 };
  });
  const out = captureStdout();
  const code = await runBackfill({
    exec: stub.exec,
    argv: ["--dry-run"],
    stdout: out.fn,
    stderr: () => {},
  });
  expect(code).toBe(0);
  const summary = JSON.parse(out.value().trim());
  expect(summary.errored).toBe(1);
  expect(summary.scanned).toBe(1);
  expect(summary.wouldWrite).toBe(0);
});

test("backfill: apitoken_hash: prefix entries are filtered out, not counted", async () => {
  const listOut = JSON.stringify([
    { name: "apitoken_hash:somehash" },
    { name: "apitoken_user:alice:tid" },
  ]);
  const stub = makeStubExec((cmd, args) => {
    if (args[2] === "list") return { stdout: listOut, stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 1 };
  });
  const out = captureStdout();
  const code = await runBackfill({
    exec: stub.exec,
    argv: ["--dry-run"],
    stdout: out.fn,
    stderr: () => {},
  });
  expect(code).toBe(0);
  const summary = JSON.parse(out.value().trim());
  expect(summary.scanned).toBe(0);
  expect(summary.wouldWrite).toBe(0);
});

test("backfill: wrangler missing → exit 2", async () => {
  const stub = makeStubExec(() => ({ stdout: "", stderr: "not found", exitCode: 127 }));
  const err = captureStdout();
  const code = await runBackfill({
    exec: stub.exec,
    argv: ["--dry-run"],
    stdout: () => {},
    stderr: err.fn,
  });
  expect(code).toBe(2);
  expect(err.value()).toContain("wrangler not found");
});
