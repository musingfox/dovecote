import { test, expect } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * C-Tooling-2: the two remaining ripgrep-backed pre-commit guards —
 * `no-empty-props-in-auth` and `no-audit-string-concat` — must catch their
 * violation AND must refuse to run when ripgrep is missing, rather than
 * exiting 0 having checked nothing.
 *
 * Both are security controls: one keeps an OAuth grant from carrying empty
 * `props` (no userId, no scopes) into downstream authorization, the other
 * keeps raw strings from being concatenated into an audit payload that
 * `writeAudit` is supposed to sanitize. A vacuous pass turns each into a
 * no-op on any machine without ripgrep.
 *
 * As in lefthook-bun-guard.test.ts we exercise the same shell the hook runs,
 * not lefthook itself. Each SHELL_GUARD is a hand copy of its block in
 * lefthook.yml; the "faithful copy" test below re-derives the hook line from
 * the copy and pins it against the real file, so the copy cannot drift
 * silently.
 */

const EMPTY_PROPS_GUARD = `
set -e
command -v rg >/dev/null || { echo "ripgrep required for no-empty-props-in-auth guard"; exit 1; }
if rg -l 'props:\\s*\\{\\s*\\}' "$1" ; then
  echo "Empty props:{} found in src/auth/** — populate with {userId, scopes}"
  exit 1
fi
`;

const AUDIT_CONCAT_GUARD = `
set -e
command -v rg >/dev/null || { echo "ripgrep required for no-audit-string-concat guard"; exit 1; }
if rg -n 'writeAudit\\([^)]*\\+\\s*[a-zA-Z_"\`'\\'']' "$1" ; then
  echo "String concatenation inside writeAudit payload — pass raw fields; writeAudit sanitizes."
  exit 1
fi
`;

async function runGuard(
  guard: string,
  file: string,
  env?: Record<string, string>,
): Promise<number> {
  const proc = Bun.spawn(["/bin/bash", "-c", guard + "\nexit 0", "_", file], {
    stdout: "pipe",
    stderr: "pipe",
    ...(env ? { env } : {}),
  });
  return await proc.exited;
}

async function fixture(name: string, content: string): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "lefthook-rg-guard-"));
  const f = join(dir, name);
  await fs.writeFile(f, content);
  return f;
}

// `PATH=/usr/bin:/bin` deterministically hides rg, which lives in
// /opt/homebrew/bin on this machine.
const NO_RG = { PATH: "/usr/bin:/bin" };

test("C-Tooling-2: no-empty-props-in-auth catches props:{} → exits 1", async () => {
  const f = await fixture("grant.ts", "export const g = { props: {} };\n");
  expect(await runGuard(EMPTY_PROPS_GUARD, f)).toBe(1);
});

test("C-Tooling-2: no-empty-props-in-auth passes a populated props → exits 0", async () => {
  const f = await fixture(
    "grant.ts",
    'export const g = { props: { userId: "u", scopes: ["dovecote:notify"] } };\n',
  );
  expect(await runGuard(EMPTY_PROPS_GUARD, f)).toBe(0);
});

test("C-Tooling-2: no-empty-props-in-auth with ripgrep absent → refuses instead of passing the violation", async () => {
  const f = await fixture("grant.ts", "export const g = { props: {} };\n");
  expect(await runGuard(EMPTY_PROPS_GUARD, f, NO_RG)).not.toBe(0);
});

test("C-Tooling-2: no-empty-props-in-auth with ripgrep absent fails even on a clean file — no vacuous pass", async () => {
  const f = await fixture("grant.ts", 'export const g = { props: { userId: "u" } };\n');
  expect(await runGuard(EMPTY_PROPS_GUARD, f, NO_RG)).not.toBe(0);
});

test("C-Tooling-2: no-audit-string-concat catches concatenation in a writeAudit payload → exits 1", async () => {
  const f = await fixture(
    "audit.ts",
    'await writeAudit(env, { reason: "bad " + userInput });\n',
  );
  expect(await runGuard(AUDIT_CONCAT_GUARD, f)).toBe(1);
});

test("C-Tooling-2: no-audit-string-concat passes a raw-field payload → exits 0", async () => {
  const f = await fixture("audit.ts", "await writeAudit(env, { reason, userInput });\n");
  expect(await runGuard(AUDIT_CONCAT_GUARD, f)).toBe(0);
});

test("C-Tooling-2: no-audit-string-concat with ripgrep absent → refuses instead of passing the violation", async () => {
  const f = await fixture(
    "audit.ts",
    'await writeAudit(env, { reason: "bad " + userInput });\n',
  );
  expect(await runGuard(AUDIT_CONCAT_GUARD, f, NO_RG)).not.toBe(0);
});

test("C-Tooling-2: no-audit-string-concat with ripgrep absent fails even on a clean file — no vacuous pass", async () => {
  const f = await fixture("audit.ts", "await writeAudit(env, { reason });\n");
  expect(await runGuard(AUDIT_CONCAT_GUARD, f, NO_RG)).not.toBe(0);
});

/**
 * The presence check has to be in the real file, per guard: a shared
 * `toContain("command -v rg")` would stay green with only one of the three
 * guards fixed, which is the state this test exists to rule out.
 */
test("C-Tooling-2: every rg-backed hook in lefthook.yml carries its own presence check", async () => {
  const yml = await fs.readFile("lefthook.yml", "utf-8");
  for (const guard of [
    "no-empty-props-in-auth",
    "no-audit-string-concat",
    "no-bun-api-in-src",
  ]) {
    expect(yml).toContain(guard);
    expect(yml).toContain(
      `command -v rg >/dev/null || { echo "ripgrep required for ${guard} guard"; exit 1; }`,
    );
  }
  // Every rg-invoking hook line in the file must be one of the three above —
  // a fourth, unguarded one would reopen the hole somewhere else.
  const rgLines = yml.split("\n").filter((l) => l.trim().startsWith("if rg "));
  expect(rgLines).toHaveLength(3);
});

test("C-Tooling-2: each SHELL_GUARD above is a faithful copy of its lefthook.yml hook line", async () => {
  const yml = await fs.readFile("lefthook.yml", "utf-8");
  for (const guard of [EMPTY_PROPS_GUARD, AUDIT_CONCAT_GUARD]) {
    const hookLine = guard
      .split("\n")
      .find((l) => l.startsWith("if rg "))!
      .replace('"$1"', "{staged_files}");
    expect(yml).toContain(hookLine);
  }
});
