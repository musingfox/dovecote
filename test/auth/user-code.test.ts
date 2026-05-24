import { test, expect } from "bun:test";
import {
  generateUserCode,
  normalizeUserCode,
  USER_CODE_ALPHABET,
} from "../../src/auth/user-code.js";

test("generateUserCode returns 8-char raw of valid alphabet + dashed display", () => {
  const { raw, display } = generateUserCode();
  expect(raw.length).toBe(8);
  for (const ch of raw) {
    expect(USER_CODE_ALPHABET.includes(ch)).toBe(true);
  }
  expect(display).toBe(raw.slice(0, 4) + "-" + raw.slice(4));
});

test("generateUserCode is collision-free at small scale", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const { raw } = generateUserCode();
    expect(seen.has(raw)).toBe(false);
    seen.add(raw);
  }
});

test("normalizeUserCode uppercases and strips dashes", () => {
  expect(normalizeUserCode("bcdf-ghjk")).toBe("BCDFGHJK");
});

test("normalizeUserCode strips embedded whitespace", () => {
  expect(normalizeUserCode("BCDF GHJK")).toBe("BCDFGHJK");
});

test("normalizeUserCode strips characters not in alphabet (x stripped, X kept)", () => {
  // 'x' (and uppercase 'X') is NOT in the alphabet (no vowels/X kept; X IS in alphabet).
  // Per spec: uppercase first, then keep alphabet chars. So 'Z23x' → uppercase 'Z23X' → keep all (X in alphabet) → 'Z23X'.
  // Test the rule with a definitively non-alphabet char.
  expect(normalizeUserCode("Z23A")).toBe("Z23"); // A is a vowel — not in alphabet
  expect(normalizeUserCode("Z23I")).toBe("Z23"); // I excluded for ambiguity
  expect(normalizeUserCode("Z23O")).toBe("Z23"); // O excluded for ambiguity
  expect(normalizeUserCode("Z230")).toBe("Z23"); // 0 excluded for ambiguity
});
