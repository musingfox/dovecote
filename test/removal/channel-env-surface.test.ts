/**
 * ChannelEnvIdentifierSweep — the two channel env-var identifiers must not come
 * back anywhere in the tracked repository (D-M9).
 *
 * Channels live in KV as `channel:<service>-<id>` records; any file that still
 * names the old worker secrets will re-teach an operator (or a setup script) to
 * write a dead variable back into production. So this test scans every path
 * `git ls-files` reports and fails with file:line for each survivor.
 *
 * Self-matching is avoided two ways: the needles are assembled by string
 * concatenation, so this source contains neither identifier, and this file's own
 * path is excluded from the scanned list regardless.
 */

import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Built by concatenation so this file cannot match itself (D-M9). */
const NEEDLES = ["TELEGRAM" + "_INSTANCES", "DISCORD" + "_INSTANCES"];

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const SELF_PATH = "test/removal/channel-env-surface.test.ts";

interface Hit {
  file: string;
  line: number;
  needle: string;
  text: string;
}

/** Every path under version control, relative to the repository root. */
function trackedFiles(): string[] {
  const res = spawnSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`git ls-files failed: ${res.stderr}`);
  }
  return res.stdout.split("\0").filter((p) => p.length > 0);
}

/**
 * Substring scan — deliberately unanchored, so a prefixed variant such as the
 * old `TEST_`-prefixed e2e overrides is caught too.
 */
function scanFiles(root: string, files: string[], needles: string[]): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(join(root, file), "utf8");
    } catch {
      continue; // unreadable (deleted or binary) — nothing to sweep
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i] ?? "";
      for (const needle of needles) {
        if (text.includes(needle)) {
          hits.push({ file, line: i + 1, needle, text: text.trim() });
        }
      }
    }
  }
  return hits;
}

const format = (hits: Hit[]): string[] =>
  hits.map((h) => `${h.file}:${h.line}: ${h.text}`);

test("T1: no tracked file mentions either channel env identifier", () => {
  const files = trackedFiles().filter((f) => f !== SELF_PATH);
  expect(format(scanFiles(REPO_ROOT, files, NEEDLES))).toEqual([]);
});

test("T2: the scanner reports a fixture that does contain the identifier", () => {
  const dir = mkdtempSync(join(tmpdir(), "channel-env-sweep-"));
  const body = ["# example", "TELEGRAM" + "_INSTANCES=[]", "# end"].join("\n");
  writeFileSync(join(dir, "fixture.env"), body);

  const hits = scanFiles(dir, ["fixture.env"], NEEDLES);
  expect(hits).toHaveLength(1);
  expect(hits[0]?.file).toBe("fixture.env");
  expect(hits[0]?.line).toBe(2);
});

test("T2b: the scanner catches a prefixed variant as a substring", () => {
  const dir = mkdtempSync(join(tmpdir(), "channel-env-sweep-"));
  writeFileSync(join(dir, "fixture.sh"), "TEST_" + "TELEGRAM" + "_INSTANCES='[]'\n");

  expect(scanFiles(dir, ["fixture.sh"], NEEDLES)).toHaveLength(1);
});

test("T3: the sweep test is tracked, excluded from the scan, and self-clean", () => {
  const tracked = trackedFiles();
  expect(tracked).toContain(SELF_PATH);
  expect(tracked.filter((f) => f !== SELF_PATH)).not.toContain(SELF_PATH);
  // Concatenated needles: scanning this very file finds nothing anyway.
  expect(scanFiles(REPO_ROOT, [SELF_PATH], NEEDLES)).toEqual([]);
});

test("T4: README deploy-secrets section points at channel:add", () => {
  const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
  const start = readme.indexOf("2. **Set secrets**");
  const end = readme.indexOf("3. **Deploy the worker**");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  expect(readme.slice(start, end)).toContain("channel:add");
});

test("T5: setup-worker-vars.sh puts no channel secret", () => {
  const script = readFileSync(
    join(REPO_ROOT, "scripts/setup-worker-vars.sh"),
    "utf8",
  );
  const secretPuts = script
    .split("\n")
    .filter((line) => line.includes("wrangler secret put"))
    .filter((line) => NEEDLES.some((needle) => line.includes(needle)));
  expect(secretPuts).toEqual([]);
});
