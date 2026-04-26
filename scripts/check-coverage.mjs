#!/usr/bin/env node
/**
 * check-coverage.mjs
 *
 * Parses coverage/lcov.info and asserts line% >= LINE_THRESHOLD and
 * function% >= FUNC_THRESHOLD. Exits 1 if either threshold is violated.
 *
 * Environment overrides:
 *   COVERAGE_LINE_THRESHOLD  (default: 0.85)
 *   COVERAGE_FUNC_THRESHOLD  (default: 0.75 — Bun lcov counts arrow/closure functions
 *                            more granularly than its terminal summary; 0.75 is the
 *                            ratchet baseline per test-flow-07 D8)
 *   LCOV_PATH                (default: coverage/lcov.info)
 *
 * Excludes test/** and scripts/** SF entries — we only gate src code.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const LINE_THRESHOLD = parseFloat(process.env.COVERAGE_LINE_THRESHOLD ?? "0.85");
const FUNC_THRESHOLD = parseFloat(process.env.COVERAGE_FUNC_THRESHOLD ?? "0.75");
const LCOV_PATH = process.env.LCOV_PATH ?? "coverage/lcov.info";

const DEFAULT_EXCLUDE = /^(test\/|scripts\/)/;

/**
 * Parses an lcov.info string and returns aggregate { lf, lh, fnf, fnh }.
 * Files matching `exclude` regex (matched against SF path) are skipped.
 * @param {string} content
 * @param {RegExp} [exclude]
 * @returns {{ lf: number, lh: number, fnf: number, fnh: number }}
 */
export function parseLcov(content, exclude = DEFAULT_EXCLUDE) {
  let lf = 0;
  let lh = 0;
  let fnf = 0;
  let fnh = 0;
  let skip = false;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("SF:")) {
      const path = trimmed.slice(3);
      skip = exclude.test(path);
    } else if (skip) {
      continue;
    } else if (trimmed.startsWith("LF:")) {
      lf += parseInt(trimmed.slice(3), 10);
    } else if (trimmed.startsWith("LH:")) {
      lh += parseInt(trimmed.slice(3), 10);
    } else if (trimmed.startsWith("FNF:")) {
      fnf += parseInt(trimmed.slice(4), 10);
    } else if (trimmed.startsWith("FNH:")) {
      fnh += parseInt(trimmed.slice(4), 10);
    }
  }

  return { lf, lh, fnf, fnh };
}

/**
 * Checks coverage totals against thresholds.
 * Returns { passed: boolean, lineRatio: number, funcRatio: number, errors: string[] }
 *
 * @param {{ lf: number, lh: number, fnf: number, fnh: number }} totals
 * @param {{ line: number, func: number }} thresholds
 */
export function checkThresholds(totals, thresholds) {
  const { lf, lh, fnf, fnh } = totals;
  const lineRatio = lf > 0 ? lh / lf : 0;
  const funcRatio = fnf > 0 ? fnh / fnf : 0;
  const errors = [];

  if (lineRatio < thresholds.line) {
    errors.push(
      `Line coverage ${(lineRatio * 100).toFixed(2)}% is below threshold ${(thresholds.line * 100).toFixed(2)}%`
    );
  }
  if (funcRatio < thresholds.func) {
    errors.push(
      `Function coverage ${(funcRatio * 100).toFixed(2)}% is below threshold ${(thresholds.func * 100).toFixed(2)}%`
    );
  }

  return { passed: errors.length === 0, lineRatio, funcRatio, errors };
}

// Only run as CLI entry point
if (import.meta.main) {
  const lcovPath = resolve(process.cwd(), LCOV_PATH);

  let content;
  try {
    content = readFileSync(lcovPath, "utf8");
  } catch (err) {
    console.error(`[check-coverage] Cannot read ${lcovPath}: ${err.message}`);
    process.exit(1);
  }

  const totals = parseLcov(content);
  const result = checkThresholds(totals, { line: LINE_THRESHOLD, func: FUNC_THRESHOLD });

  console.log(
    `[check-coverage] Lines:     ${totals.lh}/${totals.lf} = ${(result.lineRatio * 100).toFixed(2)}% (threshold: ${(LINE_THRESHOLD * 100).toFixed(2)}%)`
  );
  console.log(
    `[check-coverage] Functions: ${totals.fnh}/${totals.fnf} = ${(result.funcRatio * 100).toFixed(2)}% (threshold: ${(FUNC_THRESHOLD * 100).toFixed(2)}%)`
  );

  if (!result.passed) {
    for (const err of result.errors) {
      console.error(`[check-coverage] FAIL: ${err}`);
    }
    process.exit(1);
  }

  console.log("[check-coverage] PASS");
}
