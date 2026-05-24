import { test, expect, spyOn } from "bun:test";
import { writeAudit } from "../../src/auth/audit";
import { MockKV } from "../helpers/mock-kv";
import type { Env } from "../../src/types";

function makeEnv(): Env {
  return {
    OAUTH_KV: new MockKV() as any,
    OAUTH_PASSWORD: "test",
    COOKIE_ENCRYPTION_KEY: "x".repeat(32),
    HMAC_PEPPER: "pepper",
  };
}

function makeCtx() {
  return {
    waitUntil: (_p: Promise<any>) => {},
    passThroughOnException: () => {},
  } as any;
}

test("auth.device.authorize variant accepts clientId + userCodeFingerprint", () => {
  const env = makeEnv();
  const ctx = makeCtx();
  const spy = spyOn(console, "log");
  try {
    writeAudit(env, ctx, {
      event: "auth.device.authorize",
      ok: true,
      authMethod: "none",
      ip: "1.2.3.4",
      scope: "",
      clientId: "cli-x",
      userCodeFingerprint: "BCDF",
    });
    const logged = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(logged.event).toBe("auth.device.authorize");
    expect(logged.clientId).toBe("cli-x");
    expect(logged.userCodeFingerprint).toBe("BCDF");
    expect(logged.ok).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

test("auth.device.approve variant accepts userId on success", () => {
  const env = makeEnv();
  const ctx = makeCtx();
  const spy = spyOn(console, "log");
  try {
    writeAudit(env, ctx, {
      event: "auth.device.approve",
      ok: true,
      authMethod: "none",
      ip: "1.2.3.4",
      scope: "dovecote:notify",
      userId: "alice",
      userCodeFingerprint: "BCDF",
    });
    const logged = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(logged.event).toBe("auth.device.approve");
    expect(logged.userId).toBe("alice");
  } finally {
    spy.mockRestore();
  }
});

test("auth.device.exchange variant accepts tokenId on success", () => {
  const env = makeEnv();
  const ctx = makeCtx();
  const spy = spyOn(console, "log");
  try {
    writeAudit(env, ctx, {
      event: "auth.device.exchange",
      ok: true,
      authMethod: "none",
      ip: "1.2.3.4",
      scope: "dovecote:notify",
      userId: "alice",
      tokenId: "tid_x",
    });
    const logged = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(logged.event).toBe("auth.device.exchange");
    expect(logged.tokenId).toBe("tid_x");
  } finally {
    spy.mockRestore();
  }
});

test("log-injection guard: clientId with newline is escaped", () => {
  const env = makeEnv();
  const ctx = makeCtx();
  const spy = spyOn(console, "log");
  try {
    writeAudit(env, ctx, {
      event: "auth.device.authorize",
      ok: false,
      reason: "invalid_request",
      authMethod: "none",
      ip: "1.2.3.4",
      scope: "",
      clientId: "hax\nfake-line",
      userCodeFingerprint: "BCDF",
    });
    const raw = spy.mock.calls[0]![0] as string;
    // The serialized log line MUST be a single line — no literal newline in
    // the middle that could let an attacker inject a fake audit row.
    expect(raw.split("\n").length).toBe(1);
    // Defense-in-depth: the value gets double-escaped via the
    // `JSON.stringify(value).slice(1,-1)` pre-pass in audit.ts. JSON.parse
    // recovers a string where `\n` is the literal two characters `\` `n`
    // (NOT a newline). An attacker who controls clientId cannot inject a
    // forged line through console.log nor through the parsed-back value.
    const logged = JSON.parse(raw);
    expect(logged.clientId).toBe("hax\\nfake-line");
    expect(logged.clientId).not.toContain("\n");
  } finally {
    spy.mockRestore();
  }
});

test("log-injection guard: userCodeFingerprint with newline is escaped", () => {
  const env = makeEnv();
  const ctx = makeCtx();
  const spy = spyOn(console, "log");
  try {
    writeAudit(env, ctx, {
      event: "auth.device.approve",
      ok: true,
      authMethod: "none",
      ip: "1.2.3.4",
      scope: "",
      userCodeFingerprint: "BC\nDF",
    });
    const raw = spy.mock.calls[0]![0] as string;
    expect(raw.split("\n").length).toBe(1);
  } finally {
    spy.mockRestore();
  }
});
