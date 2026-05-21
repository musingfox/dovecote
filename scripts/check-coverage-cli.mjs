#!/usr/bin/env node
/**
 * check-coverage-cli.mjs — coverage gate for the `cli/` subproject.
 *
 * Thresholds: line >= 0.80, function >= 0.70 (per plan D-CLI-Coverage-Gate).
 * Reads `cli/coverage/lcov.info` and excludes `cli/test/**` SF entries.
 *
 * Exit codes:
 *   0  pass
 *   1  thresholds not met
 *   2  lcov file missing
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseLcov, checkThresholds } from "./check-coverage.mjs";

const LINE_THRESHOLD = parseFloat(process.env.CLI_COVERAGE_LINE_THRESHOLD ?? "0.80");
const FUNC_THRESHOLD = parseFloat(process.env.CLI_COVERAGE_FUNC_THRESHOLD ?? "0.70");
const LCOV_PATH = process.env.CLI_LCOV_PATH ?? "cli/coverage/lcov.info";

const CLI_EXCLUDE = /(^cli\/test\/|^test\/|^scripts\/)/;

const lcovPath = resolve(process.cwd(), LCOV_PATH);

let content;
try {
  content = readFileSync(lcovPath, "utf8");
} catch (err) {
  console.error(`[check-coverage-cli] missing cli/coverage/lcov.info: ${err.message}`);
  process.exit(2);
}

const totals = parseLcov(content, CLI_EXCLUDE);
const result = checkThresholds(totals, { line: LINE_THRESHOLD, func: FUNC_THRESHOLD });

console.log(
  `[check-coverage-cli] Lines:     ${totals.lh}/${totals.lf} = ${(result.lineRatio * 100).toFixed(2)}% (threshold: ${(LINE_THRESHOLD * 100).toFixed(2)}%)`
);
console.log(
  `[check-coverage-cli] Functions: ${totals.fnh}/${totals.fnf} = ${(result.funcRatio * 100).toFixed(2)}% (threshold: ${(FUNC_THRESHOLD * 100).toFixed(2)}%)`
);

if (!result.passed) {
  for (const err of result.errors) {
    console.error(`[check-coverage-cli] FAIL: line coverage ${(result.lineRatio).toFixed(2)} < ${LINE_THRESHOLD} :: ${err}`);
  }
  process.exit(1);
}

console.log("[check-coverage-cli] PASS");
