import { test, expect, mock, beforeEach, spyOn } from "bun:test";
import { Hono } from "hono";
import { createV1App } from "../../src/api-v1.js";
import type { Env } from "../../src/types.js";
import type { AuthCtx } from "../../src/auth/ctx.js";
import { MockKV } from "../helpers/mock-kv.js";
import { verifyToken, KVWriteError } from "../../src/auth/api-token.js";

function makeServices(overrides: Record<string, any> = {}) {
  return {
    sendNotification: mock(async () => ({ success: true })),
    listChannels: mock(() => [] as any[]),
    issueToken: mock(
      overrides.issueToken ??
        (async (params: any, _env: any) => ({
          token: "dvct_" + "n".repeat(32),
          tokenId: "tid_new",
          expiresAt: Date.now() + (params.ttlSeconds ?? 7_776_000) * 1000,
        }))
    ),
    revokeToken: mock(overrides.revokeToken ?? (async () => ({ revoked: true }))),
    checkRateLimit: mock(
      overrides.checkRateLimit ?? (async () => ({ allowed: true, current: 1 }))
    ),
    getTokenMetadataByTokenId: mock(
      overrides.getTokenMetadataByTokenId ??
        (async (tokenId: string) => ({
          tokenId,
          userId: "user-1",
          scopes: ["dovecote:notify"],
          hash: "hash_old",
          createdAt: Date.now() - 30 * 86400 * 1000,
          expiresAt: Date.now() + 60 * 86400 * 1000,
          label: "my-label",
        }))
    ),
    deleteTokenEntries: mock(overrides.deleteTokenEntries ?? (async () => {})),
  };
}

function buildApp(auth: AuthCtx, services = makeServices()) {
  const v1 = createV1App(services as any);
  const app = new Hono<{ Bindings: Env; Variables: { auth: AuthCtx } }>();
  app.use("/v1/*", async (c, next) => {
    c.set("auth", auth);
    await next();
  });
  app.route("/v1", v1);
  return { app, services };
}

function buildEnv(): Env {
  return {
    OAUTH_KV: new MockKV() as any,
    HMAC_PEPPER: "pepper",
  };
}

function createExecCtx() {
  return {
    props: null,
    waitUntil: (_p: Promise<any>) => {},
    passThroughOnException: () => {},
  };
}

const SELF_AUTH: AuthCtx = {
  userId: "user-1",
  scopes: ["dovecote:notify"],
  authMethod: "api_token",
  ip: "1.2.3.4",
  tokenId: "tid_self",
};
const ADMIN_AUTH: AuthCtx = {
  userId: "admin-1",
  scopes: ["dovecote:admin"],
  authMethod: "api_token",
  ip: "1.2.3.4",
  tokenId: "tid_admin",
};
const NONADMIN_OTHER: AuthCtx = {
  userId: "user-1",
  scopes: ["dovecote:notify"],
  authMethod: "api_token",
  ip: "1.2.3.4",
  tokenId: "tid_self",
};

beforeEach(() => mock.restore());

test("C-Server-2: self-renew with empty body returns 201 with new tokenId", async () => {
  const { app, services } = buildApp(SELF_AUTH);
  const env = buildEnv();

  const req = new Request("http://localhost/v1/tokens/tid_self/renew", {
    method: "POST",
  });
  const res = await app.fetch(req, env, createExecCtx());
  expect(res.status).toBe(201);
  const body = (await res.json()) as any;
  expect(body.tokenId).toBe("tid_new");
  expect(body.tokenId).not.toBe("tid_self");
  expect(body.userId).toBe("user-1");
  expect(body.scopes).toEqual(["dovecote:notify"]);
  expect(body.label).toBe("my-label");
  expect(services.issueToken).toHaveBeenCalledTimes(1);
  const call = (services.issueToken as any).mock.calls[0];
  expect(call[0].userId).toBe("user-1");
  expect(call[0].scopes).toEqual(["dovecote:notify"]);
  expect(call[0].label).toBe("my-label");
});

test("C-Server-2: self-renew with expiresIn=30d sets ttlSeconds=2_592_000", async () => {
  const { app, services } = buildApp(SELF_AUTH);
  const env = buildEnv();

  const req = new Request("http://localhost/v1/tokens/tid_self/renew", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: "30d" }),
  });
  const res = await app.fetch(req, env, createExecCtx());
  expect(res.status).toBe(201);
  const call = (services.issueToken as any).mock.calls[0];
  expect(call[0].ttlSeconds).toBe(2_592_000);
});

test("C-Server-2: admin can renew a different tokenId (201)", async () => {
  const { app } = buildApp(ADMIN_AUTH);
  const env = buildEnv();

  const req = new Request("http://localhost/v1/tokens/tid_other/renew", {
    method: "POST",
  });
  const res = await app.fetch(req, env, createExecCtx());
  expect(res.status).toBe(201);
});

test("C-Server-2: non-admin renewing a different tokenId returns 403", async () => {
  const { app } = buildApp(NONADMIN_OTHER);
  const env = buildEnv();

  const req = new Request("http://localhost/v1/tokens/tid_other/renew", {
    method: "POST",
  });
  const res = await app.fetch(req, env, createExecCtx());
  expect(res.status).toBe(403);
  const body = (await res.json()) as any;
  expect(body.error).toBe("forbidden");
});

test("C-Server-2: admin renewing non-existent tokenId returns 404", async () => {
  const { app } = buildApp(
    ADMIN_AUTH,
    makeServices({ getTokenMetadataByTokenId: async () => null })
  );
  const env = buildEnv();

  const req = new Request("http://localhost/v1/tokens/tid_missing/renew", {
    method: "POST",
  });
  const res = await app.fetch(req, env, createExecCtx());
  expect(res.status).toBe(404);
});

test("C-Server-2: invalid expiresIn enum returns 400", async () => {
  const { app } = buildApp(SELF_AUTH);
  const env = buildEnv();

  const req = new Request("http://localhost/v1/tokens/tid_self/renew", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: "1week" }),
  });
  const res = await app.fetch(req, env, createExecCtx());
  expect(res.status).toBe(400);
});

test("C-Server-2: 429 rate_limited with Retry-After: 60", async () => {
  const { app } = buildApp(
    SELF_AUTH,
    makeServices({
      checkRateLimit: async () => ({ allowed: false, current: 10 }),
    })
  );
  const env = buildEnv();
  const req = new Request("http://localhost/v1/tokens/tid_self/renew", {
    method: "POST",
  });
  const res = await app.fetch(req, env, createExecCtx());
  expect(res.status).toBe(429);
  expect(res.headers.get("Retry-After")).toBe("60");
});

test("C-Server-2: race-safe — new token persisted BEFORE old delete", async () => {
  // Track ordering: every call appends to a shared log array.
  const order: string[] = [];

  const services = makeServices({
    issueToken: async (params: any) => {
      order.push("issueToken");
      return {
        token: "dvct_NEW",
        tokenId: "tid_new",
        expiresAt: Date.now() + (params.ttlSeconds ?? 7_776_000) * 1000,
      };
    },
    deleteTokenEntries: async () => {
      order.push("deleteTokenEntries");
    },
    getTokenMetadataByTokenId: async (tokenId: string) => {
      order.push("getTokenMetadataByTokenId");
      return {
        tokenId,
        userId: "user-1",
        scopes: ["dovecote:notify"],
        hash: "hash_old",
        createdAt: Date.now() - 30 * 86400 * 1000,
        expiresAt: Date.now() + 60 * 86400 * 1000,
      };
    },
  });

  const { app } = buildApp(SELF_AUTH, services);
  const env = buildEnv();

  const req = new Request("http://localhost/v1/tokens/tid_self/renew", {
    method: "POST",
  });
  const res = await app.fetch(req, env, createExecCtx());
  expect(res.status).toBe(201);

  // Invariant: issueToken (which persists new keys) MUST happen before deleteTokenEntries
  const idxIssue = order.indexOf("issueToken");
  const idxDelete = order.indexOf("deleteTokenEntries");
  expect(idxIssue).toBeGreaterThanOrEqual(0);
  expect(idxDelete).toBeGreaterThanOrEqual(0);
  expect(idxIssue).toBeLessThan(idxDelete);
});

test("C-Server-2: zero-downtime invariant — old token verifies until delete completes (integration with KV)", async () => {
  // Use the real api-token issueToken + KV to demonstrate that:
  // 1. After issueToken for new token returns, both old and new tokens verify.
  // 2. Once deleteTokenEntries is called, only the new token verifies.
  const env = buildEnv();
  // Seed an old token via real issueToken
  const { issueToken, deleteTokenEntries, getTokenMetadataByTokenId } =
    await import("../../src/auth/api-token.js");
  const old = await issueToken(
    { userId: "user-1", scopes: ["dovecote:notify"], label: "x" },
    env
  );
  // Sanity: old token verifies
  const v1 = await verifyToken(old.token, env);
  expect(v1.kind).toBe("valid");

  // Read metadata, simulate the renew handler's order: issue new BEFORE delete old.
  const meta = await getTokenMetadataByTokenId(old.tokenId, env);
  expect(meta).not.toBeNull();
  const fresh = await issueToken(
    { userId: meta!.userId, scopes: meta!.scopes, label: meta!.label },
    env
  );

  // BEFORE delete: both verify
  expect((await verifyToken(old.token, env)).kind).toBe("valid");
  expect((await verifyToken(fresh.token, env)).kind).toBe("valid");

  await deleteTokenEntries(meta!, env);

  // AFTER delete: only new verifies
  expect((await verifyToken(old.token, env)).kind).toBe("invalid");
  expect((await verifyToken(fresh.token, env)).kind).toBe("valid");
});

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

test("coverage-guard E-A: renew unknown error -> 500, audit has tokenId===tid_self and userId===undefined", async () => {
  const logSpy = spyOn(console, "log");
  const { app } = buildApp(
    SELF_AUTH,
    makeServices({
      issueToken: async () => { throw new Error("boom"); },
    })
  );
  const env = buildEnv();

  const req = new Request("http://localhost/v1/tokens/tid_self/renew", {
    method: "POST",
  });
  const res = await app.fetch(req, env, createExecCtx());
  expect(res.status).toBe(500);
  const body = (await res.json()) as any;
  expect(body.error_description).toBe("internal error");

  const audits = findAuditCalls(
    logSpy,
    (e) => e.event === "token.issue" && e.ok === false && e.reason === "internal_error"
  );
  expect(audits.length).toBe(1);
  expect(audits[0].tokenId).toBe("tid_self");
  expect(audits[0].userId).toBeUndefined();

  logSpy.mockRestore();
});

test("coverage-guard E-B1: delete hook called once with oldMeta on renew success", async () => {
  const services = makeServices();
  const { app } = buildApp(SELF_AUTH, services);
  const env = buildEnv();

  const req = new Request("http://localhost/v1/tokens/tid_self/renew", {
    method: "POST",
  });
  const res = await app.fetch(req, env, createExecCtx());
  expect(res.status).toBe(201);

  expect(services.deleteTokenEntries).toHaveBeenCalledTimes(1);
  const deleteArg = (services.deleteTokenEntries as any).mock.calls[0][0];
  expect(deleteArg.tokenId).toBe("tid_self");
  expect(deleteArg.userId).toBe("user-1");
});

test("coverage-guard E-B2: delete failure is swallowed, renew still returns 201 with new tokenId", async () => {
  const { app } = buildApp(
    SELF_AUTH,
    makeServices({
      deleteTokenEntries: async () => { throw new Error("del fail"); },
    })
  );
  const env = buildEnv();

  const req = new Request("http://localhost/v1/tokens/tid_self/renew", {
    method: "POST",
  });
  const res = await app.fetch(req, env, createExecCtx());
  expect(res.status).toBe(201);
  const body = (await res.json()) as any;
  expect(body.tokenId).toBe("tid_new");
});

test("C-Server-2: disposition-guard: renew KVWriteError swallowed to 500 'internal error' with zero token.issue audit", async () => {
  const logSpy = spyOn(console, "log");
  const { app, services } = buildApp(
    SELF_AUTH,
    makeServices({
      issueToken: async () => {
        throw new KVWriteError("kv failure");
      },
    })
  );
  const env = buildEnv();

  const req = new Request("http://localhost/v1/tokens/tid_self/renew", {
    method: "POST",
  });
  const res = await app.fetch(req, env, createExecCtx());
  expect(res.status).toBe(500);
  const body = (await res.json()) as any;
  expect(body.error_description).toBe("internal error");

  // renew KVWriteError must NOT write any token.issue audit
  const issueAudits = findAuditCalls(
    logSpy,
    (e) => e.event === "token.issue" && e.ok === false && e.reason === "internal_error"
  );
  expect(issueAudits.length).toBe(0);

  logSpy.mockRestore();
});
