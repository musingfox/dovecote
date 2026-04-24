import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const scriptPath = join(import.meta.dir, "../../scripts/set-env-profile.sh");
const script = readFileSync(scriptPath, "utf-8");

test("writes to remote KV, not local dev cache", () => {
  expect(script).toContain("--remote");
});

test("uses OAUTH_KV binding", () => {
  expect(script).toContain("--binding OAUTH_KV");
});

test("keys are prefixed with env:", () => {
  expect(script).toMatch(/env:\$\{?PROFILE/);
});
