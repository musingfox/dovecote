import { test, expect, spyOn } from "bun:test";
import { writeAudit } from "../../src/auth/audit.js";
import { MockKV } from "../helpers/mock-kv.js";
import type { Env } from "../../src/types.js";

function buildEnv(): Env {
  return {
    OAUTH_KV: new MockKV() as any,
    OAUTH_PASSWORD: "test",
    COOKIE_ENCRYPTION_KEY: "x".repeat(32),
    HMAC_PEPPER: "pepper",
  };
}

function buildCtx() {
  return {
    waitUntil: (_p: Promise<any>) => {},
    passThroughOnException: () => {},
  } as any;
}

// C-Audit-OidcVariant: success branch
test("writeAudit auth.exchange.oidc ok=true emits issuer/userId/tokenId/authMethod", () => {
  const consoleSpy = spyOn(console, "log").mockImplementation(() => {});

  writeAudit(buildEnv(), buildCtx(), {
    event: "auth.exchange.oidc",
    ok: true,
    userId: "u-1",
    tokenId: "tid-1",
    issuer: "https://issuer.example",
    authMethod: "oidc",
    ip: "1.2.3.4",
    scope: "dovecote:notify",
  });

  expect(consoleSpy).toHaveBeenCalledTimes(1);
  const entry = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
  expect(entry.event).toBe("auth.exchange.oidc");
  expect(entry.ok).toBe(true);
  expect(entry.userId).toBe("u-1");
  expect(entry.tokenId).toBe("tid-1");
  expect(entry.authMethod).toBe("oidc");
  expect(entry.issuer).toBe("https://issuer.example");

  consoleSpy.mockRestore();
});

// C-Audit-OidcVariant: failure branch with newline-in-issuer must be escaped.
// The serialised JSON entry has no LITERAL newline inside the issuer field —
// the embedded \n is encoded as the two-character sequence "\\n".
test("writeAudit sanitizes newline in issuer for failure entries", () => {
  const consoleSpy = spyOn(console, "log").mockImplementation(() => {});

  writeAudit(buildEnv(), buildCtx(), {
    event: "auth.exchange.oidc",
    ok: false,
    reason: "untrusted_issuer",
    issuer: "https://attacker.example\nfake",
    authMethod: "oidc",
    ip: "1.2.3.4",
    scope: "",
  });

  const raw = consoleSpy.mock.calls[0]![0] as string;
  // The whole log line is one JSON document — must be a single line.
  expect(raw.includes("\n")).toBe(false);
  // Double-escaped: the raw output contains a literal `\n` two-char sequence
  // (backslash + n) inside the issuer field value. The JSON itself escapes
  // that backslash, so the on-the-wire bytes are `\\n` (four chars).
  expect(raw).toContain("attacker.example\\\\nfake");

  const entry = JSON.parse(raw);
  expect(entry.event).toBe("auth.exchange.oidc");
  expect(entry.reason).toBe("untrusted_issuer");
  // After one round-trip JSON.parse, the `\\n` shrinks to `\n` (2 chars: not
  // a real newline — it's a backslash followed by the letter n).
  expect(entry.issuer).toBe("https://attacker.example\\nfake");
  expect(entry.issuer.includes("\n")).toBe(false);

  consoleSpy.mockRestore();
});
