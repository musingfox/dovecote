import { test, expect, mock, beforeEach, spyOn } from "bun:test";
import { Hono } from "hono";
import { createV1App } from "../../src/api-v1.js";
import { InvalidScopeError, MissingPepperError } from "../../src/auth/api-token.js";
import type { Env } from "../../src/types.js";
import type { AuthCtx } from "../../src/auth/ctx.js";
import { MockKV } from "../helpers/mock-kv.js";

// Fresh service mocks per test — exercises real createV1App() from src/api-v1.ts.
function makeServices(overrides: {
  issueToken?: (...args: any[]) => any;
  revokeToken?: (...args: any[]) => any;
  checkRateLimit?: (...args: any[]) => any;
} = {}) {
  return {
    sendNotification: mock(async () => ({ success: true })),
    listChannels: mock(() => [] as any[]),
    readEnv: mock(async () => ""),
    issueToken: mock(
      overrides.issueToken ??
        (async (params: any, _env: any) => ({
          token: "dvct_" + "x".repeat(32),
          tokenId: "tid_abc",
          expiresAt: 1_000_000,
        }))
    ),
    revokeToken: mock(
      overrides.revokeToken ??
        (async (_params: any, _env: any) => ({ revoked: true }))
    ),
    checkRateLimit: mock(
      overrides.checkRateLimit ??
        (async (_kv: any, _ip: string, _ns: string) => ({ allowed: true, current: 1 }))
    ),
  };
}

function buildApp(auth: AuthCtx | null, services = makeServices()) {
  const v1 = createV1App(services as any);
  const app = new Hono<{ Bindings: Env; Variables: { auth: AuthCtx } }>();
  app.use("/v1/*", async (c, next) => {
    if (auth) c.set("auth", auth);
    await next();
  });
  app.route("/v1", v1);
  return { app, services };
}

function buildTestEnv(opts: { hmacPepper?: string } = {}): Env {
  const kv = new MockKV();
  return {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "test",
    COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length",
    HMAC_PEPPER: opts.hmacPepper ?? "test-pepper",
  };
}

function createMockExecutionContext() {
  const promises: Promise<any>[] = [];
  return {
    props: null,
    waitUntil: (p: Promise<any>) => promises.push(p),
    passThroughOnException: () => {},
  };
}

const ADMIN_AUTH: AuthCtx = {
  userId: "admin-1",
  scopes: ["dovecote:admin"],
  authMethod: "admin_token",
  ip: "1.2.3.4",
};
const NOTIFY_AUTH: AuthCtx = {
  userId: "user-1",
  scopes: ["dovecote:notify"],
  authMethod: "api_token",
  ip: "1.2.3.4",
};

function findAuditCalls(spy: ReturnType<typeof spyOn>, predicate: (entry: any) => boolean): any[] {
  const matches: any[] = [];
  for (const call of spy.mock.calls) {
    const arg = call[0];
    if (typeof arg !== "string") continue;
    try {
      const parsed = JSON.parse(arg);
      if (predicate(parsed)) matches.push(parsed);
    } catch {
      // Not a JSON audit line — ignore
    }
  }
  return matches;
}

beforeEach(() => {
  mock.restore();
});

// ============================================================
// C2.5.a — POST /v1/tokens
// ============================================================

test("C2.5.a - POST /v1/tokens success with admin scope returns 201 + token + audit", async () => {
  const consoleLogSpy = spyOn(console, "log");
  const { app } = buildApp(
    ADMIN_AUTH,
    makeServices({
      issueToken: async (_params: any, _env: any) => ({
        token: "dvct_" + "a".repeat(32),
        tokenId: "tid_xyz",
        expiresAt: 1_700_000_000_000,
      }),
    })
  );
  const env = buildTestEnv();

  const req = new Request("http://localhost/v1/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: "u1", scopes: ["dovecote:notify"], label: "ci" }),
  });
  const res = await app.fetch(req, env, createMockExecutionContext());
  expect(res.status).toBe(201);

  const body = (await res.json()) as any;
  expect(body.token).toMatch(/^dvct_/);
  expect(body.tokenId).toBe("tid_xyz");
  expect(body.userId).toBe("u1");
  expect(body.scopes).toEqual(["dovecote:notify"]);
  expect(body.expiresAt).toBe(1_700_000_000_000);
  expect(body.label).toBe("ci");

  // Audit: exactly one token.issue ok:true with tokenId/scopes/userId
  const issued = findAuditCalls(
    consoleLogSpy,
    (e) => e.event === "token.issue" && e.ok === true
  );
  expect(issued.length).toBe(1);
  expect(issued[0]).toMatchObject({
    event: "token.issue",
    ok: true,
    userId: "u1",
    tokenId: "tid_xyz",
    scopes: ["dovecote:notify"],
  });
  // D7: label NOT in audit payload
  expect((issued[0] as any).label).toBeUndefined();

  consoleLogSpy.mockRestore();
});

test("C2.5.a - POST /v1/tokens 403 forbidden when bearer lacks dovecote:admin", async () => {
  const { app } = buildApp(NOTIFY_AUTH);
  const env = buildTestEnv();

  const req = new Request("http://localhost/v1/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: "u1", scopes: ["dovecote:notify"] }),
  });
  const res = await app.fetch(req, env, createMockExecutionContext());
  expect(res.status).toBe(403);

  const body = (await res.json()) as any;
  expect(body.error).toBe("forbidden");
  expect(body.error_description).toContain("dovecote:admin");
});

test("C2.5.a - POST /v1/tokens 429 rate_limited with Retry-After: 60 and audit", async () => {
  const consoleLogSpy = spyOn(console, "log");
  const { app } = buildApp(
    ADMIN_AUTH,
    makeServices({
      checkRateLimit: async (_kv: any, _ip: string, _ns: string) => ({
        allowed: false,
        current: 6,
      }),
    })
  );
  const env = buildTestEnv();

  const req = new Request("http://localhost/v1/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: "u1", scopes: ["dovecote:notify"] }),
  });
  const res = await app.fetch(req, env, createMockExecutionContext());
  expect(res.status).toBe(429);
  expect(res.headers.get("Retry-After")).toBe("60");

  const body = (await res.json()) as any;
  expect(body.error).toBe("rate_limited");

  const rl = findAuditCalls(
    consoleLogSpy,
    (e) => e.event === "token.issue" && e.ok === false && e.reason === "rate_limited"
  );
  expect(rl.length).toBe(1);

  consoleLogSpy.mockRestore();
});

test("C2.5.a - POST /v1/tokens 400 invalid_request when issueToken throws InvalidScopeError", async () => {
  const { app } = buildApp(
    ADMIN_AUTH,
    makeServices({
      issueToken: async () => {
        throw new InvalidScopeError("bogus");
      },
    })
  );
  const env = buildTestEnv();

  const req = new Request("http://localhost/v1/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: "u1", scopes: ["bogus"] }),
  });
  const res = await app.fetch(req, env, createMockExecutionContext());
  expect(res.status).toBe(400);

  const body = (await res.json()) as any;
  expect(body.error).toBe("invalid_request");
  expect(body.error_description).toContain("bogus");
});

test("C2.5.a - POST /v1/tokens 503 misconfigured when HMAC_PEPPER missing (MissingPepperError)", async () => {
  const { app } = buildApp(
    ADMIN_AUTH,
    makeServices({
      issueToken: async () => {
        throw new MissingPepperError();
      },
    })
  );
  const env = buildTestEnv({ hmacPepper: "" });

  const req = new Request("http://localhost/v1/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: "u1", scopes: ["dovecote:notify"] }),
  });
  const res = await app.fetch(req, env, createMockExecutionContext());
  expect(res.status).toBe(503);

  const body = (await res.json()) as any;
  expect(body.error).toBe("misconfigured");
});

// ============================================================
// C2.5.b — DELETE /v1/tokens/:tokenId
// ============================================================

test("C2.5.b - DELETE /v1/tokens/:tokenId revokes existing token (200 revoked:true + audit)", async () => {
  const consoleLogSpy = spyOn(console, "log");
  const { app } = buildApp(
    ADMIN_AUTH,
    makeServices({
      revokeToken: async (params: any) => ({ revoked: true }),
    })
  );
  const env = buildTestEnv();

  const req = new Request("http://localhost/v1/tokens/tid_existing", {
    method: "DELETE",
  });
  const res = await app.fetch(req, env, createMockExecutionContext());
  expect(res.status).toBe(200);

  const body = (await res.json()) as any;
  expect(body.revoked).toBe(true);
  expect(body.tokenId).toBe("tid_existing");
  expect(body.notice).toBe("May remain usable for up to 60 seconds");

  const audited = findAuditCalls(
    consoleLogSpy,
    (e) => e.event === "token.revoke" && e.ok === true
  );
  expect(audited.length).toBe(1);
  expect(audited[0]).toMatchObject({
    event: "token.revoke",
    ok: true,
    tokenId: "tid_existing",
  });
  // Success path: no "not_found" reason
  expect((audited[0] as any).reason).toBeUndefined();

  consoleLogSpy.mockRestore();
});

test("C2.5.b - DELETE /v1/tokens/:tokenId returns revoked:false + audit reason:not_found for unknown id", async () => {
  const consoleLogSpy = spyOn(console, "log");
  const { app } = buildApp(
    ADMIN_AUTH,
    makeServices({
      revokeToken: async () => ({ revoked: false }),
    })
  );
  const env = buildTestEnv();

  const req = new Request("http://localhost/v1/tokens/tid_unknown", {
    method: "DELETE",
  });
  const res = await app.fetch(req, env, createMockExecutionContext());
  expect(res.status).toBe(200);

  const body = (await res.json()) as any;
  expect(body.revoked).toBe(false);
  expect(body.tokenId).toBe("tid_unknown");
  expect(body.notice).toBe("May remain usable for up to 60 seconds");

  const audited = findAuditCalls(
    consoleLogSpy,
    (e) =>
      e.event === "token.revoke" &&
      e.ok === true &&
      e.reason === "not_found" &&
      e.tokenId === "tid_unknown"
  );
  expect(audited.length).toBe(1);

  consoleLogSpy.mockRestore();
});

test("C2.5.b - DELETE /v1/tokens/:tokenId 403 forbidden when bearer lacks dovecote:admin", async () => {
  const { app } = buildApp(NOTIFY_AUTH);
  const env = buildTestEnv();

  const req = new Request("http://localhost/v1/tokens/tid_x", { method: "DELETE" });
  const res = await app.fetch(req, env, createMockExecutionContext());
  expect(res.status).toBe(403);

  const body = (await res.json()) as any;
  expect(body.error).toBe("forbidden");
  expect(body.error_description).toContain("dovecote:admin");
});
