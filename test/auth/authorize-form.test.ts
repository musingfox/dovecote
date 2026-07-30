/**
 * authorize-form.test.ts — AuthorizeFormRender / AuthorizeTokenGrant /
 * AuthorizeTokenReject / AuthorizeRateLimit contract tests.
 *
 * Seams are injected per-test via `createAuthorizeApp({checkRateLimit, verifyToken})`
 * — no module-level mutable state, no cross-file leakage.
 */
import { test, expect, mock } from "bun:test";
import { createAuthorizeApp } from "../../src/auth/authorize.js";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../../src/types.js";
import type { VerifyOutcome } from "../../src/auth/api-token.js";
import { MockKV } from "../helpers/mock-kv.js";

interface AuthEnv extends Env {
  OAUTH_PROVIDER: OAuthHelpers;
}

function makeProvider(): OAuthHelpers {
  return {
    parseAuthRequest: async (req: Request) => {
      const q = new URL(req.url).searchParams;
      return {
        clientId: q.get("client_id") ?? "",
        redirectUri: q.get("redirect_uri") ?? "",
        state: q.get("state") ?? "",
        scope: (q.get("scope") ?? "").split(" ").filter(Boolean),
        responseType: q.get("response_type") ?? "code",
        codeChallenge: q.get("code_challenge") ?? undefined,
        codeChallengeMethod: q.get("code_challenge_method") ?? undefined,
      } as any;
    },
    completeAuthorization: async () => ({ redirectTo: "https://client.example/cb?code=xyz&state=abc" } as any),
    lookupClient: async (clientId: string) => ({ clientId, redirectUris: ["https://client.example/cb"] } as any),
    createClient: async () => ({} as any),
    listClients: async () => ({ items: [] }),
    updateClient: async () => null,
    deleteClient: async () => {},
    listUserGrants: async () => ({ items: [] }),
    revokeGrant: async () => {},
    unwrapToken: async () => null,
    exchangeToken: async () => ({} as any),
  };
}

function makeEnv(overrides: Partial<AuthEnv> = {}): AuthEnv {
  const kv = new MockKV();
  return {
    OAUTH_KV: kv as any,
    HMAC_PEPPER: "pepper",
    OAUTH_PROVIDER: makeProvider(),
    ...overrides,
  } as AuthEnv;
}

/** ExecutionContext capturing waitUntil promises so audit KV writes can be awaited. */
function makeCtx() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p.catch(() => {}));
    },
    passThroughOnException: () => {},
  } as any;
  return { ctx, flush: () => Promise.all(pending) };
}

/** Read back all audit entries persisted to MockKV. */
async function readAuditEntries(env: AuthEnv): Promise<any[]> {
  const kv = env.OAUTH_KV as unknown as MockKV;
  const listed = await kv.list({ prefix: "audit:" });
  const entries: any[] = [];
  for (const { name } of listed.keys) {
    entries.push(await kv.get(name, "json"));
  }
  return entries;
}

const VALID_OUTCOME: VerifyOutcome = {
  kind: "valid",
  auth: {
    userId: "user1",
    scopes: ["dovecote:notify"],
    tokenId: "t1",
    authMethod: "api_token",
    ip: "unknown",
  },
};

const BASE_FORM =
  "response_type=code&client_id=test-client&redirect_uri=https%3A%2F%2Fclient.example%2Fcb&state=abc" +
  "&code_challenge=cc-abc&code_challenge_method=S256";

function postReq(body: string): Request {
  return new Request("https://example.com/authorize", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "CF-Connecting-IP": "1.2.3.4",
    },
    body,
  });
}

// ── AuthorizeFormRender ───────────────────────────────────────────────────────

test("AuthorizeFormRender T1: GET /authorize renders 200 text/html form carrying ALL OAuth query params (PKCE included) as hidden fields", async () => {
  const app = createAuthorizeApp();
  const env = makeEnv();
  const qs = `${BASE_FORM}&scope=dovecote%3Anotify`;
  const res = await app.fetch(new Request(`https://example.com/authorize?${qs}`), env, makeCtx().ctx);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  const text = await res.text();
  expect(text).toContain('name="token"');
  expect(text).toContain('action="/authorize"');
  expect(text).toContain('name="client_id" value="test-client"');
  expect(text).toContain('name="state" value="abc"');
  // PKCE parameters must survive the GET→POST round trip
  expect(text).toContain('name="code_challenge" value="cc-abc"');
  expect(text).toContain('name="code_challenge_method" value="S256"');
  expect(text).toContain('name="scope" value="dovecote:notify"');
  expect(text).toContain('name="redirect_uri" value="https://client.example/cb"');
});

test("AuthorizeFormRender T2: GET /authorize without client_id returns 400 json error=invalid_redirect_uri", async () => {
  const app = createAuthorizeApp();
  const env = makeEnv();
  const res = await app.fetch(
    new Request("https://example.com/authorize?response_type=code&redirect_uri=https%3A%2F%2Fclient.example%2Fcb&state=abc"),
    env,
    makeCtx().ctx,
  );
  expect(res.status).toBe(400);
  const body = await res.json() as any;
  expect(body.error).toBe("invalid_redirect_uri");
});

test("AuthorizeFormRender T3: GET /authorize when env missing OAUTH_PROVIDER returns 500 json error=no_provider", async () => {
  const app = createAuthorizeApp();
  const env = makeEnv({ OAUTH_PROVIDER: undefined as any });
  const res = await app.fetch(new Request(`https://example.com/authorize?${BASE_FORM}`), env, makeCtx().ctx);
  expect(res.status).toBe(500);
  const body = await res.json() as any;
  expect(body.error).toBe("no_provider");
});

// ── AuthorizeRateLimit ────────────────────────────────────────────────────────

test("AuthorizeRateLimit T1: 6th POST /authorize gets 429 + Retry-After before verify; verifyToken called 0 times; audit auth.authorize reason=rate_limited", async () => {
  const verifySpy = mock(async (): Promise<VerifyOutcome> => VALID_OUTCOME);
  const app = createAuthorizeApp({
    checkRateLimit: async () => ({ allowed: false, current: 6 }),
    verifyToken: verifySpy,
  });
  const env = makeEnv();
  const { ctx, flush } = makeCtx();
  const res = await app.fetch(postReq(`token=dvct_x&${BASE_FORM}`), env, ctx);
  expect(res.status).toBe(429);
  expect(res.headers.get("Retry-After")).toBe("60");
  const body = await res.json() as any;
  expect(body.error).toBe("rate_limited");
  expect(verifySpy).toHaveBeenCalledTimes(0);
  await flush();
  const audits = await readAuditEntries(env);
  expect(audits).toHaveLength(1);
  expect(audits[0].event).toBe("auth.authorize");
  expect(audits[0].ok).toBe(false);
  expect(audits[0].reason).toBe("rate_limited");
});

// ── AuthorizeTokenGrant ───────────────────────────────────────────────────────

test("AuthorizeTokenGrant T1: valid dvct token POST completes with 302 + code; completeAuthorization gets parsed request, userId, token scopes, identity-bearing props; audit ok", async () => {
  const p = makeProvider();
  const complete = mock(async () => ({ redirectTo: "https://client.example/cb?code=xyz&state=abc" }));
  (p as any).completeAuthorization = complete;
  const app = createAuthorizeApp({ verifyToken: async () => VALID_OUTCOME });
  const env = makeEnv({ OAUTH_PROVIDER: p });
  const { ctx, flush } = makeCtx();
  const res = await app.fetch(postReq(`token=dvct_grant1&${BASE_FORM}`), env, ctx);
  expect(res.status).toBe(302);
  expect(res.headers.get("Location") || "").toContain("code=xyz");
  expect(complete).toHaveBeenCalledTimes(1);
  const call = (complete as any).mock.calls[0]?.[0] || {};
  expect(call.userId).toBe("user1");
  expect(call.scope).toEqual(["dovecote:notify"]);
  // props carry identity — extractAuth must NOT fall back to ANONYMOUS
  expect(call.props).toEqual({
    userId: "user1",
    scopes: ["dovecote:notify"],
    authMethod: "api_token",
  });
  // request = the AuthRequest re-validated by parseAuthRequest (PKCE intact)
  expect(call.request.clientId).toBe("test-client");
  expect(call.request.codeChallenge).toBe("cc-abc");
  expect(call.request.codeChallengeMethod).toBe("S256");
  await flush();
  const audits = await readAuditEntries(env);
  expect(audits).toHaveLength(1);
  expect(audits[0].event).toBe("auth.authorize");
  expect(audits[0].ok).toBe(true);
  expect(audits[0].userId).toBe("user1");
  expect(audits[0].authMethod).toBe("api_token");
});

test("AuthorizeTokenGrant T2: tampered redirect_uri in POST (parseAuthRequest throws) -> 400; completeAuthorization not called", async () => {
  const p = makeProvider();
  (p as any).parseAuthRequest = async () => {
    throw new Error("Invalid redirect URI");
  };
  const complete = mock(async () => ({ redirectTo: "" }));
  (p as any).completeAuthorization = complete;
  const app = createAuthorizeApp({ verifyToken: async () => VALID_OUTCOME });
  const env = makeEnv({ OAUTH_PROVIDER: p });
  const res = await app.fetch(
    postReq("token=dvct_x&response_type=code&client_id=test-client&redirect_uri=https%3A%2F%2Fevil%2Fcb&state=abc"),
    env,
    makeCtx().ctx,
  );
  expect(res.status).toBe(400);
  const b = await res.json() as any;
  expect(b.error).toBe("invalid_redirect_uri");
  expect(complete).not.toHaveBeenCalled();
});

test("AuthorizeTokenGrant: ANY unrecognised parseAuthRequest failure aborts with 400 (no completeAuthorization)", async () => {
  const p = makeProvider();
  (p as any).parseAuthRequest = async () => {
    throw new Error("Invalid client. The clientId provided does not match.");
  };
  const complete = mock(async () => ({ redirectTo: "" }));
  (p as any).completeAuthorization = complete;
  const app = createAuthorizeApp({ verifyToken: async () => VALID_OUTCOME });
  const env = makeEnv({ OAUTH_PROVIDER: p });
  const res = await app.fetch(postReq(`token=dvct_x&${BASE_FORM}`), env, makeCtx().ctx);
  expect(res.status).toBe(400);
  const b = await res.json() as any;
  expect(b.error).toBe("invalid_redirect_uri");
  expect(complete).not.toHaveBeenCalled();
});

test("AuthorizeTokenGrant: completeAuthorization throw -> 500", async () => {
  const p = makeProvider();
  (p as any).completeAuthorization = async () => {
    throw new Error("boom");
  };
  const app = createAuthorizeApp({ verifyToken: async () => VALID_OUTCOME });
  const env = makeEnv({ OAUTH_PROVIDER: p });
  const res = await app.fetch(postReq(`token=dvct_x&${BASE_FORM}`), env, makeCtx().ctx);
  expect(res.status).toBe(500);
});

// ── AuthorizeTokenReject ──────────────────────────────────────────────────────

test("AuthorizeTokenReject T1: nonexistent token re-renders form 401 with 'Invalid token'; audit reason=invalid_token; no complete", async () => {
  const p = makeProvider();
  const complete = mock(async () => ({ redirectTo: "" }));
  (p as any).completeAuthorization = complete;
  const app = createAuthorizeApp({ verifyToken: async () => ({ kind: "invalid" }) });
  const env = makeEnv({ OAUTH_PROVIDER: p });
  const { ctx, flush } = makeCtx();
  const res = await app.fetch(postReq(`token=dvct_nonexistent&${BASE_FORM}`), env, ctx);
  expect(res.status).toBe(401);
  const text = await res.text();
  expect(text).toContain('name="token"');
  expect(text).toContain("Invalid token");
  // hidden fields preserved for retry
  expect(text).toContain('name="code_challenge" value="cc-abc"');
  expect(complete).not.toHaveBeenCalled();
  await flush();
  const audits = await readAuditEntries(env);
  expect(audits[0].event).toBe("auth.authorize");
  expect(audits[0].ok).toBe(false);
  expect(audits[0].reason).toBe("invalid_token");
});

test("AuthorizeTokenReject T2: expired token -> 401 'Token expired'; audit reason=expired_token", async () => {
  const app = createAuthorizeApp({
    verifyToken: async () => ({
      kind: "expired",
      tokenId: "t1",
      userId: "user1",
      scopes: ["dovecote:notify"],
    }),
  });
  const env = makeEnv();
  const { ctx, flush } = makeCtx();
  const res = await app.fetch(postReq(`token=dvct_exp&${BASE_FORM}`), env, ctx);
  expect(res.status).toBe(401);
  const text = await res.text();
  expect(text).toContain("Token expired");
  await flush();
  const audits = await readAuditEntries(env);
  expect(audits[0].event).toBe("auth.authorize");
  expect(audits[0].reason).toBe("expired_token");
});

test("AuthorizeTokenReject T3: missing token field -> 400 'Token required'; audit reason=missing_token", async () => {
  const verifySpy = mock(async (): Promise<VerifyOutcome> => VALID_OUTCOME);
  const app = createAuthorizeApp({ verifyToken: verifySpy });
  const env = makeEnv();
  const { ctx, flush } = makeCtx();
  const res = await app.fetch(postReq(BASE_FORM), env, ctx);
  expect(res.status).toBe(400);
  const text = await res.text();
  expect(text).toContain("Token required");
  expect(text).toContain('name="token"');
  expect(verifySpy).toHaveBeenCalledTimes(0);
  await flush();
  const audits = await readAuditEntries(env);
  expect(audits[0].event).toBe("auth.authorize");
  expect(audits[0].reason).toBe("missing_token");
});
