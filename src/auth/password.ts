/**
 * Password hashing and verification (Contract D).
 *
 * PBKDF2-SHA256, 100k iterations, 32-byte derived key, 16-byte random salt.
 * Salt and hash are base64-encoded. `pepper` is mixed into the password
 * material; must be non-empty.
 */

const ITERATIONS = 100_000;
const KEY_LENGTH_BYTES = 32;
const SALT_LENGTH_BYTES = 16;

export interface PasswordRecord {
  algo: "pbkdf2-sha256";
  iterations: number;
  salt: string;
  hash: string;
}

export class MissingPepperError extends Error {
  constructor() {
    super("HMAC_PEPPER is required for password hashing");
    this.name = "MissingPepperError";
  }
}

export class UnsupportedAlgorithmError extends Error {
  constructor(algo: string) {
    super(`Unsupported password algorithm: ${algo}`);
    this.name = "UnsupportedAlgorithmError";
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

async function deriveBits(
  password: string,
  pepper: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const material = enc.encode(password + pepper);
  const baseKey = await crypto.subtle.importKey(
    "raw",
    material,
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256",
    },
    baseKey,
    KEY_LENGTH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(
  password: string,
  pepper: string,
): Promise<PasswordRecord> {
  if (!pepper) {
    throw new MissingPepperError();
  }
  const salt = new Uint8Array(SALT_LENGTH_BYTES);
  crypto.getRandomValues(salt);
  const hash = await deriveBits(password, pepper, salt, ITERATIONS);
  return {
    algo: "pbkdf2-sha256",
    iterations: ITERATIONS,
    salt: bytesToBase64(salt),
    hash: bytesToBase64(hash),
  };
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

export async function verifyPassword(
  password: string,
  pepper: string,
  record: PasswordRecord,
): Promise<boolean> {
  if (!pepper) {
    throw new MissingPepperError();
  }
  if (record.algo !== "pbkdf2-sha256") {
    throw new UnsupportedAlgorithmError(record.algo);
  }
  const salt = base64ToBytes(record.salt);
  const expected = base64ToBytes(record.hash);
  const derived = await deriveBits(password, pepper, salt, record.iterations);
  return timingSafeEqualBytes(derived, expected);
}
