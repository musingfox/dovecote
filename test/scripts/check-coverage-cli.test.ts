import { test, expect } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

// Integration test for scripts/check-coverage-cli.mjs:
//   - line=85% func=72% → exit 0
//   - line=75% → exit 1
//   - missing lcov → exit 2
//
// We invoke the script with CLI_LCOV_PATH pointing at a temp file.

const SCRIPT = "scripts/check-coverage-cli.mjs";

function makeLcov(opts: { lf: number; lh: number; fnf: number; fnh: number }) {
  return `
SF:cli/src/main.ts
FN:1,fnA
FN:2,fnB
FN:3,fnC
FNF:${opts.fnf}
FNH:${opts.fnh}
LF:${opts.lf}
LH:${opts.lh}
end_of_record
`.trim();
}

test("C-Tooling-2: line=85% func=72% → exit 0", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "cli-cov-pass-"));
  const lcov = join(dir, "lcov.info");
  await fs.writeFile(lcov, makeLcov({ lf: 100, lh: 85, fnf: 100, fnh: 72 }));
  const proc = Bun.spawn(["node", SCRIPT], {
    env: { ...process.env, CLI_LCOV_PATH: lcov },
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  expect(code).toBe(0);
});

test("C-Tooling-2: line=75% → exit 1 with reason", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "cli-cov-fail-"));
  const lcov = join(dir, "lcov.info");
  await fs.writeFile(lcov, makeLcov({ lf: 100, lh: 75, fnf: 100, fnh: 80 }));
  const proc = Bun.spawn(["node", SCRIPT], {
    env: { ...process.env, CLI_LCOV_PATH: lcov },
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  expect(code).toBe(1);
  const err = await new Response(proc.stderr).text();
  expect(err).toContain("line coverage 0.75");
});

test("C-Tooling-2: missing lcov → exit 2", async () => {
  const proc = Bun.spawn(["node", SCRIPT], {
    env: { ...process.env, CLI_LCOV_PATH: "/no/such/path.info" },
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  expect(code).toBe(2);
  const err = await new Response(proc.stderr).text();
  expect(err).toContain("missing cli/coverage/lcov.info");
});
