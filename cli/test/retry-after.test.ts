import { test, expect } from "bun:test";
import { parseRetryAfter } from "../src/retry-after.ts";

test("parseRetryAfter parses integer seconds", () => {
  expect(parseRetryAfter("30", 1_700_000_000_000)).toBe(30);
});

test("parseRetryAfter parses RFC 1123 HTTP-date into seconds", () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  const value = new Date(now + 10_000).toUTCString();
  expect(parseRetryAfter(value, now)).toBe(10);
});

test("parseRetryAfter returns null for malformed values", () => {
  expect(parseRetryAfter("notanumber", 1_700_000_000_000)).toBeNull();
  expect(parseRetryAfter("", 1_700_000_000_000)).toBeNull();
  expect(parseRetryAfter(null, 1_700_000_000_000)).toBeNull();
});

test("parseRetryAfter clamps past HTTP-dates to zero", () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  const value = new Date(now - 10_000).toUTCString();
  expect(parseRetryAfter(value, now)).toBe(0);
});

test("parseRetryAfter preserves zero integer seconds", () => {
  expect(parseRetryAfter("0", 1_700_000_000_000)).toBe(0);
});
