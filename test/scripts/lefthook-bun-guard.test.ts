import { test, expect } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * C-Tooling-1: lefthook `no-bun-api-in-src` hook fails when staged files
 * under src/ contain `Bun.` API references; passes otherwise.
 *
 * We don't run lefthook itself; we exercise the same `rg` command the hook
 * uses, which is the unit of behavior we care about.
 */

const SHELL_GUARD = `
set -e
if rg -n '\\bBun\\.' "$1" ; then
  echo "Bun.* API found in src/** — worker module must stay portable; move Bun-specific code to cli/ or scripts/."
  exit 1
fi
`;

async function runGuard(file: string): Promise<number> {
  const proc = Bun.spawn(["bash", "-c", SHELL_GUARD + "\nexit 0", "_", file], {
    stdout: "pipe",
    stderr: "pipe",
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

test("C-Tooling-1: lefthook.yml contains the no-bun-api-in-src hook block", async () => {
  const yml = await fs.readFile("lefthook.yml", "utf-8");
  expect(yml).toContain("no-bun-api-in-src");
  expect(yml).toContain("\\bBun\\.");
});
