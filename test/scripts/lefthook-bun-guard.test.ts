import { test, expect } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * C-Tooling-1: lefthook `no-bun-api-in-src` hook fails when staged files
 * under src/ contain `Bun.` API references; passes otherwise, and fails loudly
 * rather than silently passing when ripgrep is not installed.
 *
 * We don't run lefthook itself; we exercise the same shell the hook uses, which
 * is the unit of behavior we care about. SHELL_GUARD must stay a faithful copy
 * of the `no-bun-api-in-src` block in lefthook.yml.
 */

const SHELL_GUARD = `
set -e
command -v rg >/dev/null || { echo "ripgrep required for no-bun-api-in-src guard"; exit 1; }
if rg -n '\\bBun\\.' "$1" ; then
  echo "Bun.* API found in src/** — worker module must stay portable; move Bun-specific code to cli/ or scripts/."
  exit 1
fi
`;

async function runGuard(file: string, env?: Record<string, string>): Promise<number> {
  const proc = Bun.spawn(["/bin/bash", "-c", SHELL_GUARD + "\nexit 0", "_", file], {
    stdout: "pipe",
    stderr: "pipe",
    ...(env ? { env } : {}),
  });
  return await proc.exited;
}

test("C-Tooling-1: file containing Bun.serve(...) → guard exits 1", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "lefthook-guard-"));
  const f = join(dir, "evil.ts");
  await fs.writeFile(f, "export const x = Bun.serve({});\n");
  const code = await runGuard(f);
  expect(code).toBe(1);
});

test("C-Tooling-1: file with 'Bun.serve' inside a string literal still trips guard (accepted false-positive)", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "lefthook-guard-"));
  const f = join(dir, "stringy.ts");
  await fs.writeFile(f, 'export const x = "Bun.serve is illegal here";\n');
  const code = await runGuard(f);
  expect(code).toBe(1);
});

test("C-Tooling-1: file with no Bun.* references → guard exits 0", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "lefthook-guard-"));
  const f = join(dir, "clean.ts");
  await fs.writeFile(f, "export const x = fetch('https://example.com');\n");
  const code = await runGuard(f);
  expect(code).toBe(0);
});

// A missing scanner used to make the whole guard a no-op: `if rg ...` exited 127,
// the branch was skipped, and the hook returned 0 with no sign that nothing had been
// checked. The guard must now refuse to run rather than pass vacuously.
test("C-Tooling-1: ripgrep absent from PATH → guard exits non-zero instead of passing", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "lefthook-guard-"));
  const f = join(dir, "evil.ts");
  await fs.writeFile(f, "export const x = Bun.serve({});\n");
  // rg lives in /opt/homebrew/bin on this machine; this PATH deterministically hides it.
  const code = await runGuard(f, { PATH: "/usr/bin:/bin" });
  expect(code).not.toBe(0);
});

test("C-Tooling-1: lefthook.yml contains the no-bun-api-in-src hook block", async () => {
  const yml = await fs.readFile("lefthook.yml", "utf-8");
  expect(yml).toContain("no-bun-api-in-src");
  expect(yml).toContain("\\bBun\\.");
  // The tool-presence check is part of the guard, not an optimisation. Pin
  // this guard's own message: a bare "command -v rg" would also match a
  // sibling hook's check and stay green with this one unfixed.
  expect(yml).toContain(
    'command -v rg >/dev/null || { echo "ripgrep required for no-bun-api-in-src guard"; exit 1; }',
  );
});
