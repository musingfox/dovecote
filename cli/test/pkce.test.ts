import { test, expect } from "bun:test";
import {
  generateCodeVerifier,
  generateCodeChallenge,
  base64UrlEncode,
  isLoopbackRedirect,
  LOOPBACK_REGEX,
} from "../src/pkce.ts";

test("generateCodeVerifier returns a base64url string", () => {
  const v = generateCodeVerifier();
  expect(typeof v).toBe("string");
  expect(v.length).toBeGreaterThan(20);
  expect(v).not.toContain("+");
  expect(v).not.toContain("/");
  expect(v).not.toContain("=");
});

test("generateCodeChallenge is deterministic for the same verifier", async () => {
  const v = "test-verifier-12345";
  const a = await generateCodeChallenge(v);
  const b = await generateCodeChallenge(v);
  expect(a).toBe(b);
  // SHA-256 → 32 bytes → base64url ~43 chars
  expect(a.length).toBeGreaterThan(40);
});

test("base64UrlEncode replaces + / =", () => {
  // bytes that produce + and / in base64
  const bytes = new Uint8Array([0xff, 0xff, 0xff]);
  const out = base64UrlEncode(bytes);
  expect(out).not.toContain("+");
  expect(out).not.toContain("/");
  expect(out).not.toContain("=");
});

test("isLoopbackRedirect accepts 127.0.0.1 + ipv6, rejects others", () => {
  expect(isLoopbackRedirect("http://127.0.0.1:12345")).toBe(true);
  expect(isLoopbackRedirect("http://[::1]:42")).toBe(true);
  expect(isLoopbackRedirect("http://localhost:12345")).toBe(false);
  expect(isLoopbackRedirect("https://127.0.0.1:12345")).toBe(false);
  expect(isLoopbackRedirect("http://127.0.0.1")).toBe(false);
  expect(LOOPBACK_REGEX.test("http://127.0.0.1:1")).toBe(true);
});
