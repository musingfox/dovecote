import { test, expect } from "bun:test";
import { CLI_VERSION, compareVersions } from "../src/version.ts";

test("CLI_VERSION is a semver string", () => {
  expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+/);
});

test("compareVersions: equal", () => {
  expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
});

test("compareVersions: less than", () => {
  expect(compareVersions("0.1.0", "0.2.0")).toBe(-1);
  expect(compareVersions("0.1.0", "1.0.0")).toBe(-1);
  expect(compareVersions("0.0.5", "0.1.0")).toBe(-1);
});

test("compareVersions: greater than", () => {
  expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
  expect(compareVersions("0.2.0", "0.1.99")).toBe(1);
});

test("compareVersions handles missing parts", () => {
  expect(compareVersions("1", "1.0.0")).toBe(0);
  expect(compareVersions("1.0", "1.0.0")).toBe(0);
});
