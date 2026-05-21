import { test, expect, mock, beforeEach, spyOn } from "bun:test";
import { Hono } from "hono";
import { createAuthExchangeApp } from "../../src/auth-exchange.js";
import { InvalidScopeError, MissingPepperError } from "../../src/auth/api-token.js";
import type { Env } from "../../src/types.js";
import { MockKV } from "../helpers/mock-kv.js";

function makeServices(overrides: {
  issueToken?: (...args: any[]) => any;
  checkRateLimit?: (...args: any[]) => any;
  unwrapOAuthToken?: (...args: any[]) => any;
} = {}) {
  return {
    issueToken: mock(
      overrides.issueToken ??
        (async (_params: any, _env: any) => ({
          token: "dvct_" + "a".repeat(32),
          tokenId: "tid_new",
          expiresAt: Date.now() + 7_776_000 * 1000,
        }))
    ),
    checkRateLimit: mock(
      overrides.checkRateLimit ??
        (async () => ({ allowed: true, current: 1 }))
    ),
    unwrapOAuthToken: mock(
      overrides.unwrapOAuthToken ??
        (async () => ({
          userId: "operator",
          scopes: ["dovecote:admin", "dovecote:notify"],
          expiresAtMs: Date.now() + 3600 * 1000,
        }))
    ),
  };
}

function buildEnv(opts: { hmacPepper?: string } = {}): Env {
  return {
    OAUTH_KV: new MockKV() as any,
    OAUTH_PASSWORD: "test",
    COOKIE_ENCRYPTION_KEY: "k".repeat(32),
    HMAC_PEPPER: opts.hmacPepper ?? "pepper",
  };
}

function createExecCtx() {
  return {
    props: null,
    waitUntil: (_p: Promise<any>) => {},
    passThroughOnException: () => {},
  };
}

function buildApp(services = makeServices()) {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/", createAuthExchangeApp(services as any));
  return { app, services };
}

beforeEach(() => {
  mock.restore();
});

test("C-Server-1: 201 admin OAuth bearer with empty body uses default 90d TTL", async () => {
  const { app, services } = buildApp();
  const env = buildEnv();

  const req = new Request("http://localhost/v1/auth/exchange", {
    method: "POST",
    headers: { Authorization: "Bearer oauth_token_abc" },
  });
  const res = await app.fetch(req, env, createExecCtx());
  expect(res.status).toBe(201);

  const body = (await res.json()) as any;
  expect(body.token).toMatch(/^dvct_/);
  expect(body.tokenId).toBe("tid_new");
  expect(body.userId).toBe("operator");
  expect(body.scopes).toEqual(["dovecote:admin", "dovecote:notify"]);

  // issueToken should be called without ttlSeconds (default 90d)
  expect(services.issueToken).toHaveBeenCalledTimes(1);
  const call = (services.issueToken as any).mock.calls[0];
  expect(call[0].ttlSeconds).toBeUndefined();
  expect(call[0].userId).toBe("operator");
  expect(call[0].scopes).toEqual(["dovecote:admin", "dovecote:notify"]);
});

test("C-Server-1: 201 with explicit expiresIn=7d and label", async () => {
  const { app, services } = buildApp(
    makeServices({
      unwrapOAuthToken: async () => ({
        userId: "operator",
        scopes: ["dovecote:admin"],
        expiresAtMs: Date.now() + 3600 * 1000,
      }),
    })
  );
  const env = buildEnv();
  const req = new Request("http://localhost/v1/auth/exchange", {
    method: "POST",
    headers: {
      Authorization: "Bearer oauth_token_abc",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expiresIn: "7d", label: "cli-bootstrap" }),
  });
  const res = await app.fetch(req, env, createExecCtx());
  expect(res.status).toBe(201);

  const body = (await res.json()) as any;
  expect(body.label).toBe("cli-bootstrap");
  const call = (services.issueToken as any).mock.calls[0];
  expect(call[0].ttlSeconds).toBe(604_800);
  expect(call[0].label).toBe("cli-bootstrap");
});

test("C-Server-1: 403 when OAuth token lacks dovecote:admin", async () => {
  const { app } = buildApp(
    makeServices({
      unwrapOAuthToken: async () => ({
        userId: "operator",
        scopes: ["dovecote:notify"],
        expiresAtMs: Date.now() + 3600 * 1000,
      }),
    })
  );
  const env = buildEnv();
  const req = new Request("http://localhost/v1/auth/exchange", {
    method: "POST",
    headers: { Authorization: "Bearer oauth_token_abc" },
  });
  const res = await app.fetch(req, env, createExecCtx());
  expect(res.status).toBe(403);
  const body = (await res.json()) as any;
  expect(body.error).toBe("forbidden");
});

test("C-Server-1: 401 invalid_token when unwrapToken returns null", async () => {
  const { app } = buildApp(
    makeServices({
      unwrapOAuthToken: async () => null,
    })
  );
  const env = buildEnv();
  const req = new Request("http://localhost/v1/auth/exchange", {
    method: "POST",
    headers: { Authorization: "Bearer bad_token" },
  });
  const res = await app.fetch(req, env, createExecCtx());
  expect(res.status).toBe(401);
  const body = (await res.json()) as any;
  expect(body.error_description).toBe("invalid_token");
});

test("C-Server-1: 401 expired_token when OAuth expiresAt is past", async () => {
  const { app } = buildApp(
    makeServices({
      unwrapOAuthToken: async () => ({
        userId: "operator",
        scopes: ["dovecote:admin"],
        expiresAtMs: Date.now() - 1000,
      }),
    })
  );
  const env = buildEnv();
  const req = new Request("http://localhost/v1/auth/exchange", {
    method: "POST",
    headers: { Authorization: "Bearer expired_token" },
  });
  const res = await app.fetch(req, env, createExecCtx());
  expect(res.status).toBe(401);
  const body = (await res.json()) as any;
  expect(body.error_description).toBe("expired_token");
});

test("C-Server-1: 400 invalid_request on bad expiresIn enum", async () => {
  const { app } = buildApp();
  const env = buildEnv();
  const req = new Request("http://localhost/v1/auth/exchange", {
    method: "POST",
    headers: {
      Authorization: "Bearer oauth_token_abc",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expiresIn: "30days" }),
  });
  const res = await app.fetch(req, env, createExecCtx());
  expect(res.status).toBe(400);
  const body = (await res.json()) as any;
  expect(body.error).toBe("invalid_request");
});

test("C-Server-1: 429 rate_limited with Retry-After: 60", async () => {
  const { app } = buildApp(
    makeServices({
      checkRateLimit: async () => ({ allowed: false, current: 999 }),
    })
  );
  const env = buildEnv();
  const req = new Request("http://localhost/v1/auth/exchange", {
    method: "POST",
    headers: { Authorization: "Bearer oauth_token_abc" },
  });
  const res = await app.fetch(req, env, createExecCtx());
  expect(res.status).toBe(429);
  expect(res.headers.get("Retry-After")).toBe("60");
});

test("C-Server-1: 503 misconfigured when issueToken throws MissingPepperError", async () => {
  const { app } = buildApp(
    makeServices({
      issueToken: async () => {
        throw new MissingPepperError();
      },
    })
  );
  const env = buildEnv({ hmacPepper: "" });
  const req = new Request("http://localhost/v1/auth/exchange", {
    method: "POST",
    headers: { Authorization: "Bearer oauth_token_abc" },
  });
  const res = await app.fetch(req, env, createExecCtx());
  expect(res.status).toBe(503);
  const body = (await res.json()) as any;
  expect(body.error).toBe("misconfigured");
});

test("C-Server-1: 401 missing_authorization when Authorization header absent", async () => {
  const { app } = buildApp();
  const env = buildEnv();
  const req = new Request("http://localhost/v1/auth/exchange", {
    method: "POST",
  });
  const res = await app.fetch(req, env, createExecCtx());
  expect(res.status).toBe(401);
  const body = (await res.json()) as any;
  expect(body.error_description).toBe("missing_authorization");
});

test("C-Server-1: audit token.issue ok:true on success with authMethod=oauth", async () => {
  const consoleLogSpy = spyOn(console, "log");
  const { app } = buildApp();
  const env = buildEnv();
  const req = new Request("http://localhost/v1/auth/exchange", {
    method: "POST",
    headers: { Authorization: "Bearer oauth_token_abc" },
  });
  await app.fetch(req, env, createExecCtx());

  const entries = consoleLogSpy.mock.calls
    .map((c) => {
      try {
        return JSON.parse(c[0] as string);
      } catch {
        return null;
      }
    })
    .filter((e): e is any => e && e.event === "token.issue" && e.ok === true);
  expect(entries.length).toBe(1);
  expect(entries[0].authMethod).toBe("oauth");
  expect(entries[0].userId).toBe("operator");

  consoleLogSpy.mockRestore();
});
