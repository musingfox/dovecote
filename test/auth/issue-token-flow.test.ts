/**
 * Regression tests for issueTokenFlow helper (src/auth/issue-token-flow.ts).
 *
 * Pins 6 branches:
 *   1. RL-denied: 429 + Retry-After
 *   2. Success: 201 + success audit
 *   3. InvalidScopeError: 400
 *   4. MissingPepperError: 503
 *   5. KVWriteError: config-driven body
 *        - errorMode "surface" (admin/device) -> "Failed to persist token"
 *        - errorMode "swallow" (auth-exchange/oidc) -> "internal error"
 *   6. Unknown error: config-driven disposition
 *        - errorMode "surface" (admin/device) -> rethrow (text/plain 500 via Hono)
 *        - errorMode "swallow" (auth-exchange/oidc) -> swallow (json 500)
 */
import { test, expect, mock, spyOn, beforeEach } from "bun:test";
import { Hono } from "hono";
import { issueTokenFlow, type IssueTokenFlowOpts } from "../../src/auth/issue-token-flow.js";
import {
  InvalidScopeError,
  KVWriteError,
  MissingPepperError,
} from "../../src/auth/api-token.js";
import { MockKV } from "../helpers/mock-kv.js";
import type { Env } from "../../src/types.js";

function makeEnv(): Env {
  return {
    OAUTH_KV: new MockKV() as any,
    HMAC_PEPPER: "pepper",
  } as any;
}

function execCtx(): any {
  return { waitUntil: (_p: Promise<any>) => {}, passThroughOnException: () => {} };
}

function makeOpts(overrides: Partial<IssueTokenFlowOpts> & { services: IssueTokenFlowOpts["services"] }): IssueTokenFlowOpts {
  return {
    env: makeEnv(),
    ctx: execCtx(),
    ip: "1.2.3.4",
    userId: "alice",
    scopes: ["dovecote:notify"],
    rateLimitNamespace: "tokens",
    authMethod: "oauth",
    auditScope: "dovecote:notify",
    successStatus: 201,
    ...overrides,
  };
}

/** Drive issueTokenFlow through a Hono app so rethrows surface as text/plain 500. */
function makeApp(opts: IssueTokenFlowOpts): { app: Hono<any>; env: Env } {
  const env = opts.env;
  const app = new Hono<any>();
  app.post("/test", (c) => issueTokenFlow(c as any, opts));
  return { app, env };
}

const okIssue = mock(async () => ({
  token: "dvct_" + "a".repeat(32),
  tokenId: "tid_test",
  expiresAt: Date.now() + 7_776_000_000,
}));

beforeEach(() => {
  mock.restore();
});

// ---------------------------------------------------------------------------
// 1. RL-denied
// ---------------------------------------------------------------------------
test("RL-denied: 429 + Retry-After", async () => {
  const rlDeny = mock(async () => ({ allowed: false, current: 100 }));
  const opts = makeOpts({
    services: {
      issueToken: okIssue,
      checkRateLimit: rlDeny,
    },
  });
  const { app, env } = makeApp(opts);
  const res = await app.fetch(new Request("http://localhost/test", { method: "POST" }), env, execCtx());
  expect(res.status).toBe(429);
  expect(res.headers.get("Retry-After")).toBe("60");
  const body = (await res.json()) as any;
  expect(body.error).toBe("rate_limited");
});

// ---------------------------------------------------------------------------
// 2. Success: 201 + audit
// ---------------------------------------------------------------------------
test("success: 201 + success audit emitted", async () => {
  const spy = spyOn(console, "log").mockImplementation(() => {});
  try {
    const issueToken = mock(async () => ({
      token: "dvct_" + "a".repeat(32),
      tokenId: "tid_success",
      expiresAt: Date.now() + 1000,
    }));
    const opts = makeOpts({ services: { issueToken } });
    const { app, env } = makeApp(opts);
    const res = await app.fetch(new Request("http://localhost/test", { method: "POST" }), env, execCtx());
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.tokenId).toBe("tid_success");
    // Verify audit was written
    const calls = spy.mock.calls;
    const auditCall = calls.find((c) => {
      try {
        const p = JSON.parse(c[0] as string);
        return p.ok === true && p.event === "token.issue";
      } catch { return false; }
    });
    expect(auditCall).toBeDefined();
  } finally {
    spy.mockRestore();
  }
});

// ---------------------------------------------------------------------------
// 3. InvalidScopeError: 400
// ---------------------------------------------------------------------------
test("InvalidScopeError: 400", async () => {
  const issueToken = mock(async () => {
    throw new InvalidScopeError("bad scope");
  });
  const opts = makeOpts({ services: { issueToken } });
  const { app, env } = makeApp(opts);
  const res = await app.fetch(new Request("http://localhost/test", { method: "POST" }), env, execCtx());
  expect(res.status).toBe(400);
  const body = (await res.json()) as any;
  expect(body.error).toBe("invalid_request");
});

// ---------------------------------------------------------------------------
// 4. MissingPepperError: 503
// ---------------------------------------------------------------------------
test("MissingPepperError: 503", async () => {
  const issueToken = mock(async () => {
    throw new MissingPepperError();
  });
  const opts = makeOpts({ services: { issueToken } });
  const { app, env } = makeApp(opts);
  const res = await app.fetch(new Request("http://localhost/test", { method: "POST" }), env, execCtx());
  expect(res.status).toBe(503);
  const body = (await res.json()) as any;
  expect(body.error).toBe("misconfigured");
});

// ---------------------------------------------------------------------------
// 5. KVWriteError: config-driven body
// ---------------------------------------------------------------------------
test("KVWriteError errorMode=surface: 500 'Failed to persist token'", async () => {
  const issueToken = mock(async () => { throw new KVWriteError("kv down"); });
  const opts = makeOpts({ errorMode: "surface", services: { issueToken } });
  const { app, env } = makeApp(opts);
  const res = await app.fetch(new Request("http://localhost/test", { method: "POST" }), env, execCtx());
  expect(res.status).toBe(500);
  const body = (await res.json()) as any;
  expect(body.error_description).toBe("Failed to persist token");
});

test("KVWriteError errorMode=swallow: 500 'internal error' (NOT persist msg)", async () => {
  const issueToken = mock(async () => { throw new KVWriteError("kv down"); });
  const opts = makeOpts({ errorMode: "swallow", services: { issueToken } });
  const { app, env } = makeApp(opts);
  const res = await app.fetch(new Request("http://localhost/test", { method: "POST" }), env, execCtx());
  expect(res.status).toBe(500);
  const body = (await res.json()) as any;
  expect(body.error_description).toBe("internal error");
  expect(body.error_description).not.toBe("Failed to persist token");
});

// ---------------------------------------------------------------------------
// 6. Unknown error: config-driven disposition
// ---------------------------------------------------------------------------
test("unknown error errorMode=surface: rethrow (text/plain 500)", async () => {
  const issueToken = mock(async () => { throw new Error("boom unknown"); });
  const opts = makeOpts({ errorMode: "surface", services: { issueToken } });
  const { app, env } = makeApp(opts);
  const res = await app.fetch(new Request("http://localhost/test", { method: "POST" }), env, execCtx());
  expect(res.status).toBe(500);
  expect(res.headers.get("content-type") ?? "").toContain("text/plain");
  expect(await res.text()).toBe("Internal Server Error");
});

test("unknown error errorMode=swallow: json 500 internal_error", async () => {
  const issueToken = mock(async () => { throw new Error("boom unknown"); });
  const opts = makeOpts({ errorMode: "swallow", services: { issueToken } });
  const { app, env } = makeApp(opts);
  const res = await app.fetch(new Request("http://localhost/test", { method: "POST" }), env, execCtx());
  expect(res.status).toBe(500);
  expect(res.headers.get("content-type") ?? "").toContain("application/json");
  const body = (await res.json()) as any;
  expect(body.error).toBe("internal_error");
});
