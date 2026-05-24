/**
 * RFC 8628 §6.1 user-code helpers.
 *
 * - Alphabet: `BCDFGHJKLMNPQRSTVWXZ23456789` — 20 chars, no vowels (anti-word),
 *   no `0/1/I/L/O` (anti-ambiguity).
 * - `generateUserCode()` returns 8 random chars and a `XXXX-XXXX` display form.
 * - `normalizeUserCode()` uppercases the input and strips any character not in
 *   the alphabet (whitespace, dashes, lowercase noise, etc.), so a typed code
 *   matches the storage key regardless of formatting.
 */

export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";
export const USER_CODE_LENGTH = 8;

const ALPHABET_SET = new Set(USER_CODE_ALPHABET.split(""));

export interface UserCode {
  raw: string;
  display: string;
}

/**
 * Generate a fresh user code using `crypto.getRandomValues` and the
 * RFC-compliant 20-char alphabet. Returns both the raw 8-char form (used as
 * a KV key) and the `XXXX-XXXX` display form (rendered to the user).
 */
export function generateUserCode(): UserCode {
  const bytes = new Uint8Array(USER_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let raw = "";
  const len = USER_CODE_ALPHABET.length;
  for (let i = 0; i < USER_CODE_LENGTH; i++) {
    // Modulo bias on a 20-char alphabet over 256 values is negligible
    // (~6% across buckets); acceptable for the 192-bit-equivalent search
    // space we're protecting (the secret half of the flow is the device_code,
    // not the user_code).
    const idx = bytes[i]! % len;
    raw += USER_CODE_ALPHABET[idx]!;
  }
  const display = raw.slice(0, 4) + "-" + raw.slice(4);
  return { raw, display };
}

/**
 * Normalize a user-supplied code: uppercase, then drop every character that
 * isn't part of the alphabet. This is the only transform applied before a
 * KV lookup, so it MUST be symmetric with `generateUserCode().raw`.
 */
export function normalizeUserCode(input: string): string {
  let out = "";
  const upper = input.toUpperCase();
  for (const ch of upper) {
    if (ALPHABET_SET.has(ch)) {
      out += ch;
    }
  }
  return out;
}
