import { test, expect } from "bun:test";
import { resolve } from "node:path";

const ACTION_DIR = resolve(import.meta.dir, "../../.github/actions/setup-dovecote");

test("every github.action_path reference in setup-dovecote resolves to a file in the repo", async () => {
  const yml = await Bun.file(`${ACTION_DIR}/action.yml`).text();
  const refs = [...yml.matchAll(/\$\{\{\s*github\.action_path\s*\}\}(\/[^"'\s]+)/g)].map((m) => m[1]!);
  expect(refs.length).toBeGreaterThan(0);
  for (const ref of refs) {
    expect({ ref, exists: await Bun.file(ACTION_DIR + ref).exists() }).toEqual({ ref, exists: true });
  }
});
