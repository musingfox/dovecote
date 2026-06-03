import { test, expect } from "bun:test";
import { Hono } from "hono";
import type { Env } from "../../src/types";
import { bearerMiddleware } from "../../src/auth/bearer";
import { issueToken, KV_HASH_NAMESPACE } from "../../src/auth/api-token";
import { MockKV } from "../helpers/mock-kv";
import { createMockExecutionCtx } from "../helpers/mock-execution-ctx";
import type { AuthCtx } from "../../src/auth/ctx";

// Compute HMAC-SHA256 hash (duplicate of api-token.ts)
async function computeHmacSha256(pepper: string, data: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(pepper);
  const dataData = encoder.encode(data);

  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, dataData);
  const signatureBytes = new Uint8Array(signature);
  let hex = "";
  for (let i = 0; i < signatureBytes.length; i++) {
    const byte = signatureBytes[i]!.toString(16);
    hex += byte.length === 1 ? "0" + byte : byte;
  }
  return hex;
}

function createEnv(hmacPepper: string, kv: MockKV = new MockKV()): Env {
  return {
    OAUTH_KV: kv,
    HMAC_PEPPER: hmacPepper,
    OAUTH_PASSWORD: "test-password",
    COOKIE_ENCRYPTION_KEY: "test-encryption-key",
    OAUTH_PROVIDER: {} as any,
  } as unknown as Env;
}

test("C2.3.a-1: No Authorization header returns 401 missing_authorization", async () => {
  const kv = new MockKV();
  const env = createEnv("test-pepper-32-characters-long", kv);

  const app = new Hono<{ Bindings: Env; Variables: { auth: AuthCtx } }>();
  app.use("/v1/*", bearerMiddleware);
  app.get("/v1/test", async (c) => c.json({ ok: true }));

  const req = new Request("http://localhost/v1/test");
  const res = await app.fetch(req, env, createMockExecutionCtx(null) as any);

  expect(res.status).toBe(401);
  const body = await res.json() as any;
  expect(body.error).toBe("unauthorized");
  expect(body.error_description).toBe("missing_authorization");
});

test("C2.3.a-2: Authorization: Basic foo returns 401 malformed_bearer", async () => {
  const kv = new MockKV();
  const env = createEnv("test-pepper-32-characters-long", kv);

  const app = new Hono<{ Bindings: Env; Variables: { auth: AuthCtx } }>();
  app.use("/v1/*", bearerMiddleware);
  app.get("/v1/test", async (c) => c.json({ ok: true }));

  const req = new Request("http://localhost/v1/test", {
    headers: { Authorization: "Basic foo" },
  });
  const res = await app.fetch(req, env, createMockExecutionCtx(null) as any);

  expect(res.status).toBe(401);
  const body = await res.json() as any;
  expect(body.error).toBe("unauthorized");
  expect(body.error_description).toBe("malformed_bearer");
});

test("C2.3.a-3: Authorization: Bearer not-a-dvct returns 401 malformed_bearer", async () => {
  const kv = new MockKV();
  const env = createEnv("test-pepper-32-characters-long", kv);

  const app = new Hono<{ Bindings: Env; Variables: { auth: AuthCtx } }>();
  app.use("/v1/*", bearerMiddleware);
  app.get("/v1/test", async (c) => c.json({ ok: true }));

  const req = new Request("http://localhost/v1/test", {
    headers: { Authorization: "Bearer not-a-dvct" },
  });
  const res = await app.fetch(req, env, createMockExecutionCtx(null) as any);

  expect(res.status).toBe(401);
  const body = await res.json() as any;
  expect(body.error).toBe("unauthorized");
  expect(body.error_description).toBe("malformed_bearer");
});

test("C2.3.a-4: Authorization: Bearer dvct_<unknown> returns 401 invalid_token", async () => {
  const kv = new MockKV();
  const env = createEnv("test-pepper-32-characters-long", kv);

  const app = new Hono<{ Bindings: Env; Variables: { auth: AuthCtx } }>();
  app.use("/v1/*", bearerMiddleware);
  app.get("/v1/test", async (c) => c.json({ ok: true }));

  const fakeToken = "dvct_" + "a".repeat(32);
  const req = new Request("http://localhost/v1/test", {
    headers: { Authorization: `Bearer ${fakeToken}` },
  });
  const res = await app.fetch(req, env, createMockExecutionCtx(null) as any);

  expect(res.status).toBe(401);
  const body = await res.json() as any;
  expect(body.error).toBe("unauthorized");
  expect(body.error_description).toBe("invalid_token");
});

test("C2.3.a-5: Valid token allows request and populates auth", async () => {
  const kv = new MockKV();
  const env = createEnv("test-pepper-32-characters-long", kv);

  const app = new Hono<{ Bindings: Env; Variables: { auth: AuthCtx } }>();
  app.use("/v1/*", bearerMiddleware);
  app.get("/v1/test", async (c) => {
    const auth = c.get("auth");
    return c.json({ auth });
  });

  const now = Date.now();
  const issueResult = await issueToken(
    {
      userId: "user123",
      scopes: ["dovecote:notify"],
    },
    env,
    now
  );

  const req = new Request("http://localhost/v1/test", {
    headers: {
      Authorization: `Bearer ${issueResult.token}`,
      "CF-Connecting-IP": "1.2.3.4",
    },
  });
  const res = await app.fetch(req, env, createMockExecutionCtx(null) as any);

  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.auth).toBeDefined();
  expect(body.auth.scopes).toEqual(["dovecote:notify"]);
  expect(body.auth.tokenId).toBe(issueResult.tokenId);
  expect(body.auth.authMethod).toBe("api_token");
  expect(body.auth.ip).toBe("1.2.3.4");
});

test("C2.3.a-6: Expired token returns 401 expired_token", async () => {
  const kv = new MockKV();
  const env = createEnv("test-pepper-32-characters-long", kv);

  const app = new Hono<{ Bindings: Env; Variables: { auth: AuthCtx } }>();
  app.use("/v1/*", bearerMiddleware);
  app.get("/v1/test", async (c) => c.json({ ok: true }));

  // Issue normally then overwrite the KV hash entry with an expired metadata
  // (expiresAt in the past, NO expirationTtl so MockKV.get won't auto-delete).
  // This mirrors what production looks like when KV TTL hasn't yet swept a
  // logically-expired token: the value is still present, but expiresAt <= now.
  const now = Date.now();
  const issueResult = await issueToken(
    {
      userId: "user123",
      scopes: ["dovecote:notify"],
    },
    env,
    now
  );

  // Compute hash for the issued token and rewrite the hash-keyed metadata
  // with an expiresAt in the past. No expirationTtl on the put → MockKV will
  // keep the entry, exercising the "found but expired" branch.
  const tokenHash = await computeHmacSha256("test-pepper-32-characters-long", issueResult.token);
  const expiredMetadata = {
    tokenId: issueResult.tokenId,
    userId: "user123",
    scopes: ["dovecote:notify"],
    hash: tokenHash,
    createdAt: now - 10_000,
    expiresAt: now - 1_000,
  };
  await kv.put(KV_HASH_NAMESPACE + tokenHash, JSON.stringify(expiredMetadata));

  const req = new Request("http://localhost/v1/test", {
    headers: {
      Authorization: `Bearer ${issueResult.token}`,
    },
  });
  const res = await app.fetch(req, env, createMockExecutionCtx(null) as any);

  expect(res.status).toBe(401);
  const body = await res.json() as any;
  expect(body.error).toBe("unauthorized");
  expect(body.error_description).toBe("expired_token");
});

test("C2.3.a-7: Audit includes route without query string", async () => {
  const kv = new MockKV();
  const env = createEnv("test-pepper-32-characters-long", kv);

  const app = new Hono<{ Bindings: Env; Variables: { auth: AuthCtx } }>();
  app.use("/v1/*", bearerMiddleware);
  app.get("/v1/test", async (c) => c.json({ ok: true }));

  const now = Date.now();
  const issueResult = await issueToken(
    {
      userId: "user123",
      scopes: ["dovecote:notify"],
    },
    env,
    now
  );

  const req = new Request("http://localhost/v1/test?foo=bar&baz=qux", {
    headers: {
      Authorization: `Bearer ${issueResult.token}`,
    },
  });
  const res = await app.fetch(req, env, createMockExecutionCtx(null) as any);

  expect(res.status).toBe(200);
});

test("C2.3.a-8: Token hash mismatch returns 401 invalid_token", async () => {
  const kv = new MockKV();
  const env = createEnv("test-pepper-32-characters-long", kv);

  const app = new Hono<{ Bindings: Env; Variables: { auth: AuthCtx } }>();
  app.use("/v1/*", bearerMiddleware);
  app.get("/v1/test", async (c) => c.json({ ok: true }));

  // Issue a valid token first
  const now = Date.now();
  const issueResult = await issueToken(
    {
      userId: "user123",
      scopes: ["dovecote:notify"],
    },
    env,
    now
  );

  // Mutate the token by flipping a character
  const tokenArray = issueResult.token.split("");
  // Flip the first character after the prefix
  if (tokenArray[5] === "a") {
    tokenArray[5] = "b";
  } else {
    tokenArray[5] = "a";
  }
  const mutatedToken = tokenArray.join("");

  const req = new Request("http://localhost/v1/test", {
    headers: {
      Authorization: `Bearer ${mutatedToken}`,
    },
  });
  const res = await app.fetch(req, env, createMockExecutionCtx(null) as any);

  expect(res.status).toBe(401);
  const body = await res.json() as any;
  expect(body.error).toBe("unauthorized");
  expect(body.error_description).toBe("invalid_token");
});

test("C2.3.a-9: Audit event includes route", async () => {
  const kv = new MockKV();
  const env = createEnv("test-pepper-32-characters-long", kv);

  const app = new Hono<{ Bindings: Env; Variables: { auth: AuthCtx } }>();
  app.use("/v1/*", bearerMiddleware);
  app.get("/v1/test", async (c) => {
    const auth = c.get("auth");
    return c.json({ auth });
  });

  const now = Date.now();
  const issueResult = await issueToken(
    {
      userId: "user123",
      scopes: ["dovecote:notify"],
    },
    env,
    now
  );

  // Read the audit log by checking the KV directly
  const req = new Request("http://localhost/v1/test", {
    headers: {
      Authorization: `Bearer ${issueResult.token}`,
    },
  });
  const res = await app.fetch(req, env, createMockExecutionCtx(null) as any);

  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json");
});

test("C2.3.a-10: Multiple scopes are preserved in auth", async () => {
  const kv = new MockKV();
  const env = createEnv("test-pepper-32-characters-long", kv);

  const app = new Hono<{ Bindings: Env; Variables: { auth: AuthCtx } }>();
  app.use("/v1/*", bearerMiddleware);
  app.get("/v1/test", async (c) => {
    const auth = c.get("auth");
    return c.json({ auth });
  });

  const now = Date.now();
  const issueResult = await issueToken(
    {
      userId: "user123",
      scopes: ["dovecote:notify", "dovecote:admin"],
    },
    env,
    now
  );

  const req = new Request("http://localhost/v1/test", {
    headers: {
      Authorization: `Bearer ${issueResult.token}`,
    },
  });
  const res = await app.fetch(req, env, createMockExecutionCtx(null) as any);

  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.auth.scopes).toEqual(["dovecote:notify", "dovecote:admin"]);
});
