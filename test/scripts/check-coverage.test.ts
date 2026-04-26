import { test, expect, describe } from "bun:test";
import { parseLcov, checkThresholds } from "../../scripts/check-coverage.mjs";

// Fixture: lcov.info with two source files
// File 1: 80 lines found, 72 hit; 10 functions found, 9 hit
// File 2: 20 lines found, 18 hit; 5 functions found, 4 hit
// Aggregate: LF=100, LH=90, FNF=15, FNH=13
// line%  = 90/100 = 0.90
// func%  = 13/15  = 0.8667
const FIXTURE_PASS = `
SF:src/a.ts
FN:1,funcA1
FN:5,funcA2
FN:10,funcA3
FN:15,funcA4
FN:20,funcA5
FN:25,funcA6
FN:30,funcA7
FN:35,funcA8
FN:40,funcA9
FN:45,funcA10
FNH:9
FNF:10
LF:80
LH:72
end_of_record
SF:src/b.ts
FN:1,funcB1
FN:5,funcB2
FN:10,funcB3
FN:15,funcB4
FN:20,funcB5
FNH:4
FNF:5
LF:20
LH:18
end_of_record
`.trim();

// Fixture that will fail both thresholds
// LF=100, LH=50 → 50% lines
// FNF=10, FNH=5 → 50% functions
const FIXTURE_FAIL = `
SF:src/c.ts
FNH:5
FNF:10
LF:100
LH:50
end_of_record
`.trim();

describe("parseLcov", () => {
  test("aggregates LF, LH, FNF, FNH across multiple source files", () => {
    const result = parseLcov(FIXTURE_PASS);
    expect(result.lf).toBe(100);
    expect(result.lh).toBe(90);
    expect(result.fnf).toBe(15);
    expect(result.fnh).toBe(13);
  });

  test("returns zeros for empty input", () => {
    const result = parseLcov("");
    expect(result.lf).toBe(0);
    expect(result.lh).toBe(0);
    expect(result.fnf).toBe(0);
    expect(result.fnh).toBe(0);
  });
});

describe("checkThresholds", () => {
  test("passes when coverage meets thresholds (line=0.85, func=0.85)", () => {
    // 90% lines, ~86.67% functions — both above 0.85
    const totals = { lf: 100, lh: 90, fnf: 15, fnh: 13 };
    const result = checkThresholds(totals, { line: 0.85, func: 0.85 });
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.lineRatio).toBeCloseTo(0.9, 5);
    expect(result.funcRatio).toBeCloseTo(13 / 15, 5);
  });

  test("fails when line coverage is below threshold", () => {
    // 50% lines, 90% functions
    const totals = { lf: 100, lh: 50, fnf: 10, fnh: 9 };
    const result = checkThresholds(totals, { line: 0.85, func: 0.85 });
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("line"))).toBe(true);
  });

  test("fails when function coverage is below threshold", () => {
    // 90% lines, 50% functions
    const totals = { lf: 100, lh: 90, fnf: 10, fnh: 5 };
    const result = checkThresholds(totals, { line: 0.85, func: 0.85 });
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("function"))).toBe(true);
  });

  test("fails both when both are below threshold", () => {
    const totals = parseLcov(FIXTURE_FAIL);
    const result = checkThresholds(totals, { line: 0.85, func: 0.85 });
    expect(result.passed).toBe(false);
    expect(result.errors).toHaveLength(2);
  });

  test("treats lf=0 as 0% line coverage", () => {
    const totals = { lf: 0, lh: 0, fnf: 0, fnh: 0 };
    const result = checkThresholds(totals, { line: 0.85, func: 0.85 });
    expect(result.lineRatio).toBe(0);
    expect(result.funcRatio).toBe(0);
    expect(result.passed).toBe(false);
  });

  test("passes with threshold=0 even for zero coverage", () => {
    const totals = { lf: 0, lh: 0, fnf: 0, fnh: 0 };
    const result = checkThresholds(totals, { line: 0, func: 0 });
    expect(result.passed).toBe(true);
  });
});
