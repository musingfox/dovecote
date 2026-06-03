import { test, expect } from "bun:test";
import authorizeApp from "../../src/auth/authorize.js";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../../src/types.js";
import { SCOPES_SUPPORTED, SCOPE_DESCRIPTIONS } from "../../src/auth/scopes.js";
import { MockKV } from "../helpers/mock-kv.js";
import { hashPassword } from "../../src/auth/password.js";

const PEPPER = "test-pepper";

// Mock OAUTH_PROVIDER
const mockAuthRequest: AuthRequest = {
  clientId: "abc",
  redirectUri: "https://claude.ai/api/mcp/auth_callback",
  state: "xyz",
  codeChallenge: "abc123",
  codeChallengeMethod: "S256",
  scope: ["dovecote:notify"],
  responseType: "code",
};

let lastCompleteAuthCall: any = null;

function makeMockProvider(): OAuthHelpers {
  return {
    parseAuthRequest: async () => mockAuthRequest,
    completeAuthorization: async (params: any) => {
      if (!params.props || !params.props.userId || !params.props.scopes) {
        throw new Error("Missing required props");
      }
      lastCompleteAuthCall = params;
      return {
        redirectTo: `${mockAuthRequest.redirectUri}?code=test-code&state=${mockAuthRequest.state}`,
      };
    },
    lookupClient: async () => null,
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

interface AuthEnv extends Env {
  OAUTH_PROVIDER: OAuthHelpers;
}

function makeEnv(overrides: Partial<AuthEnv> = {}): AuthEnv {
  const provider = makeMockProvider();
  return {
    OAUTH_KV: new MockKV() as any,
    OAUTH_PASSWORD: "",
    COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length",
    HMAC_PEPPER: PEPPER,
    OAUTH_PROVIDER: provider,
    TELEGRAM_INSTANCES: undefined,
    DISCORD_INSTANCES: undefined,
    ...overrides,
  };
}

async function seedUser(
  kv: MockKV,
  username: string,
  password: string,
  scopes: string[],
) {
  const rec = await hashPassword(password, PEPPER);
  await kv.put(
    `user:${username}`,
    JSON.stringify({
      username,
      algo: rec.algo,
      iterations: rec.iterations,
      salt: rec.salt,
      hash: rec.hash,
      scopes,
      createdAt: "2026-05-22T00:00:00Z",
    }),
  );
}

// ---------------------------------------------------------------------------
// GET /authorize – form rendering
// ---------------------------------------------------------------------------

test("GET /authorize returns 200 with authorization form", async () => {
  const env = makeEnv();
  const url = new URL("https://example.com/authorize");
  url.searchParams.set("client_id", "abc");
  url.searchParams.set("redirect_uri", "https://claude.ai/api/mcp/auth_callback");
  url.searchParams.set("state", "xyz");
  url.searchParams.set("code_challenge", "abc123");
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", "dovecote:notify");
  url.searchParams.set("response_type", "code");

  const req = new Request(url.toString());
  const res = await authorizeApp.fetch(req, env);

  expect(res.status).toBe(200);

  const html = await res.text();
  expect(html).toContain("<form");
  expect(html).toContain('name="username"');
  expect(html).toContain('name="password"');
  expect(html).toContain('name="csrf_token"');
  expect(html).toContain('value="abc"');

  // Username input must appear before password input
  const usernameIdx = html.indexOf('name="username"');
  const passwordIdx = html.indexOf('name="password"');
  expect(usernameIdx).toBeGreaterThan(0);
  expect(passwordIdx).toBeGreaterThan(0);
  expect(usernameIdx).toBeLessThan(passwordIdx);

  // Check for Set-Cookie header
  const setCookie = res.headers.get("Set-Cookie");
  expect(setCookie).toBeTruthy();
  expect(setCookie).toContain("csrf=");
});

// ---------------------------------------------------------------------------
// POST helpers
// ---------------------------------------------------------------------------

async function getCsrfCredentials(env: AuthEnv, scope: string): Promise<{ csrfToken: string; cookieValue: string }> {
  const getRes = await authorizeApp.fetch(
    new Request(`https://example.com/authorize?client_id=abc&redirect_uri=https://claude.ai/api/mcp/auth_callback&state=xyz&code_challenge=abc&code_challenge_method=S256&scope=${encodeURIComponent(scope)}&response_type=code`),
    env,
  );
  const html = await getRes.text();
  const csrfMatch = html.match(/name="csrf_token" value="([^"]+)"/);
  const cookieMatch = getRes.headers.get("Set-Cookie")!.match(/csrf=([^;]+)/);
  return {
    csrfToken: csrfMatch![1]!,
    cookieValue: cookieMatch![1]!,
  };
}

async function postAuthorize(
  env: AuthEnv,
  opts: {
    csrfToken: string;
    cookieValue: string;
    scope: string;
    username?: string;
    password?: string;
    omitUsername?: boolean;
  },
): Promise<Response> {
  const formData = new FormData();
  formData.append("csrf_token", opts.csrfToken);
  if (!opts.omitUsername && opts.username !== undefined) {
    formData.append("username", opts.username);
  }
  if (opts.password !== undefined) {
    formData.append("password", opts.password);
  }
  formData.append("response_type", "code");
  formData.append("client_id", "abc");
  formData.append("redirect_uri", "https://claude.ai/api/mcp/auth_callback");
  formData.append("state", "xyz");
  formData.append("scope", opts.scope);
  formData.append("code_challenge", "abc");
  formData.append("code_challenge_method", "S256");

  return authorizeApp.fetch(
    new Request("https://example.com/authorize", {
      method: "POST",
      headers: { Cookie: `csrf=${opts.cookieValue}` },
      body: formData,
    }),
    env,
  );
}

// ---------------------------------------------------------------------------
// POST /authorize basic happy-path / failure
// ---------------------------------------------------------------------------

test("POST /authorize with correct creds (KV-seeded) and valid CSRF returns 302", async () => {
  const kv = new MockKV();
  await seedUser(kv, "alice", "correct-password", ["dovecote:notify"]);
  const env = makeEnv({ OAUTH_KV: kv as any });

  const creds = await getCsrfCredentials(env, "dovecote:notify");
  const res = await postAuthorize(env, { ...creds, scope: "dovecote:notify", username: "alice", password: "correct-password" });

  expect(res.status).toBe(302);
  const location = res.headers.get("Location");
  expect(location).toContain("code=");
  expect(location).toContain("state=xyz");
});

test("POST /authorize with wrong password returns 403", async () => {
  const kv = new MockKV();
  await seedUser(kv, "alice", "correct-password", ["dovecote:notify"]);
  const env = makeEnv({ OAUTH_KV: kv as any });

  const creds = await getCsrfCredentials(env, "dovecote:notify");
  const res = await postAuthorize(env, { ...creds, scope: "dovecote:notify", username: "alice", password: "wrong-password" });

  expect(res.status).toBe(403);
  expect(await res.text()).toContain("Invalid credentials");
});

test("POST /authorize with correct password but invalid CSRF returns 403", async () => {
  const env = makeEnv();
  const formData = new FormData();
  formData.append("csrf_token", "fake-token");
  formData.append("username", "alice");
  formData.append("password", "correct-password");
  formData.append("response_type", "code");
  formData.append("client_id", "abc");
  formData.append("redirect_uri", "https://claude.ai/api/mcp/auth_callback");
  formData.append("state", "xyz");
  formData.append("scope", "dovecote:notify");

  const postReq = new Request("https://example.com/authorize", {
    method: "POST",
    headers: {
      Cookie: "csrf=fake-cookie-value.fake-hmac",
    },
    body: formData,
  });

  const postRes = await authorizeApp.fetch(postReq, env);
  expect(postRes.status).toBe(403);
  expect(await postRes.text()).toContain("Invalid CSRF token");
});

// ---------------------------------------------------------------------------
// Scope filtering helper unit tests
// ---------------------------------------------------------------------------

function filterScopes(scope: string): string[] {
  const requestedScopes = scope.split(" ");
  return requestedScopes.filter((s) =>
    (SCOPES_SUPPORTED as readonly string[]).includes(s),
  );
}

test("authorize scope filter: one supported, one unsupported", () => {
  expect(filterScopes("dovecote:notify admin:delete")).toEqual(["dovecote:notify"]);
});

test("authorize scope filter: no supported scopes", () => {
  expect(filterScopes("admin:delete")).toEqual([]);
});

test("authorize scope filter: empty string", () => {
  expect(filterScopes("")).toEqual([]);
});

// ---------------------------------------------------------------------------
// SCOPE_DESCRIPTIONS
// ---------------------------------------------------------------------------

test("SCOPE_DESCRIPTIONS contains dovecote:notify with correct description", () => {
  expect(SCOPE_DESCRIPTIONS["dovecote:notify"].description).toBe("傳送通知訊息至已連結的頻道");
});

test("SCOPE_DESCRIPTIONS dovecote:notify has no warning", () => {
  expect(SCOPE_DESCRIPTIONS["dovecote:notify"].warning).toBeUndefined();
});

// ---------------------------------------------------------------------------
// GET /authorize – scope handling
// ---------------------------------------------------------------------------

function envWithScope(scope: string[]): AuthEnv {
  const env = makeEnv();
  env.OAUTH_PROVIDER = {
    ...env.OAUTH_PROVIDER,
    parseAuthRequest: async () => ({ ...mockAuthRequest, scope }),
  };
  return env;
}

test("GET /authorize with valid scope dovecote:notify returns 200", async () => {
  const env = envWithScope(["dovecote:notify"]);
  const res = await authorizeApp.fetch(new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://example.com&state=xyz&response_type=code&scope=dovecote:notify"), env);
  expect(res.status).toBe(200);
});

test("GET /authorize with dovecote:admin returns 200 and renders description and warning", async () => {
  const env = envWithScope(["dovecote:admin"]);
  const res = await authorizeApp.fetch(new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://example.com&state=xyz&response_type=code&scope=dovecote:admin"), env);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("dovecote:admin");
  expect(html).toContain("執行 admin 等級操作");
  expect(html).toContain('<div class="scope-warning">');
});

test("GET /authorize with mixed valid and invalid scope returns 400", async () => {
  const env = envWithScope(["dovecote:notify", "foo:bar"]);
  const res = await authorizeApp.fetch(new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://example.com&state=xyz&response_type=code&scope=dovecote:notify%20foo:bar"), env);
  expect(res.status).toBe(400);
});

test("GET /authorize with empty scope array returns 200", async () => {
  const env = envWithScope([]);
  const res = await authorizeApp.fetch(new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://example.com&state=xyz&response_type=code"), env);
  expect(res.status).toBe(200);
});

test("GET /authorize with dovecote:notify shows description but no warning", async () => {
  const env = envWithScope(["dovecote:notify"]);
  const res = await authorizeApp.fetch(new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://example.com&state=xyz&response_type=code&scope=dovecote:notify"), env);
  const html = await res.text();
  expect(html).toContain("傳送通知訊息至已連結的頻道");
  expect(html).not.toContain('<div class="scope-warning">');
});

// Snapshot tests - normalized CSRF
test("GET /authorize HTML snapshot for dovecote:notify", async () => {
  const env = envWithScope(["dovecote:notify"]);
  const res = await authorizeApp.fetch(new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://example.com&state=xyz&response_type=code&scope=dovecote:notify"), env);
  const html = await res.text();
  const normalizedHtml = html.replace(/name="csrf_token" value="[^"]+"/g, 'name="csrf_token" value="NORMALIZED_CSRF_TOKEN"');
  expect(normalizedHtml).toMatchSnapshot("dovecote:notify");
});

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

test("GET /authorize 200 response includes Content-Security-Policy header", async () => {
  const env = makeEnv();
  const res = await authorizeApp.fetch(new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://example.com&state=xyz&response_type=code&scope=dovecote:notify"), env);
  expect(res.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
});

test("GET /authorize 200 response includes X-Frame-Options header", async () => {
  const env = makeEnv();
  const res = await authorizeApp.fetch(new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://example.com&state=xyz&response_type=code&scope=dovecote:notify"), env);
  expect(res.headers.get("X-Frame-Options")).toBe("DENY");
});

test("GET /authorize 200 response includes Referrer-Policy header", async () => {
  const env = makeEnv();
  const res = await authorizeApp.fetch(new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://example.com&state=xyz&response_type=code&scope=dovecote:notify"), env);
  expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
});

test("GET /authorize 400 invalid scope includes all security headers", async () => {
  const env = envWithScope(["foo:bar"]);
  const res = await authorizeApp.fetch(new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://example.com&state=xyz&response_type=code&scope=foo:bar"), env);
  expect(res.status).toBe(400);
  expect(res.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
  expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
});

// ---------------------------------------------------------------------------
// Contract B: dovecote:admin scope plumbing
// ---------------------------------------------------------------------------

test("Contract B: SCOPES_SUPPORTED includes dovecote:admin", () => {
  expect((SCOPES_SUPPORTED as readonly string[]).includes("dovecote:admin")).toBe(true);
});

test("Contract B: SCOPE_DESCRIPTIONS[dovecote:admin].description is non-empty", () => {
  expect(SCOPE_DESCRIPTIONS["dovecote:admin"].description).toBeTruthy();
});

test("Contract B: SCOPE_DESCRIPTIONS[dovecote:admin].warning is non-empty", () => {
  expect(SCOPE_DESCRIPTIONS["dovecote:admin"].warning).toBeTruthy();
});

test("Contract B: filterScopes retains dovecote:admin alongside dovecote:notify", () => {
  expect(filterScopes("dovecote:notify dovecote:admin")).toEqual(["dovecote:notify", "dovecote:admin"]);
});

test("Contract B: GET /authorize with dovecote:admin mixed invalid scope returns 400", async () => {
  const env = envWithScope(["dovecote:admin", "foo:bar"]);
  const res = await authorizeApp.fetch(new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://example.com&state=xyz&response_type=code&scope=dovecote:admin%20foo:bar"), env);
  expect(res.status).toBe(400);
  const body = await res.text();
  expect(body).toContain("Invalid scope requested");
});

// ---------------------------------------------------------------------------
// Contract G: POST /authorize dispatches via resolveUserId + per-user scope enforcement
// ---------------------------------------------------------------------------

test("Contract G: valid alice + dovecote:notify scope (alice has notify) → 302, completeAuthorization gets alice", async () => {
  const kv = new MockKV();
  await seedUser(kv, "alice", "correct", ["dovecote:notify"]);
  const env = makeEnv({ OAUTH_KV: kv as any });
  lastCompleteAuthCall = null;

  const creds = await getCsrfCredentials(env, "dovecote:notify");
  const res = await postAuthorize(env, { ...creds, scope: "dovecote:notify", username: "alice", password: "correct" });

  expect(res.status).toBe(302);
  expect(lastCompleteAuthCall).not.toBeNull();
  expect(lastCompleteAuthCall.userId).toBe("alice");
  expect(lastCompleteAuthCall.scope).toEqual(["dovecote:notify"]);
  expect(lastCompleteAuthCall.props.userId).toBe("alice");
  expect(lastCompleteAuthCall.props.scopes).toEqual(["dovecote:notify"]);
});

test("Contract G: alice + wrong password → 403", async () => {
  const kv = new MockKV();
  await seedUser(kv, "alice", "correct", ["dovecote:notify"]);
  const env = makeEnv({ OAUTH_KV: kv as any });

  const creds = await getCsrfCredentials(env, "dovecote:notify");
  const res = await postAuthorize(env, { ...creds, scope: "dovecote:notify", username: "alice", password: "wrong" });
  expect(res.status).toBe(403);
  expect(await res.text()).toContain("Invalid credentials");
});

test("Contract G: alice requests dovecote:admin but lacks admin scope → 403 insufficient scope", async () => {
  const kv = new MockKV();
  await seedUser(kv, "alice", "correct", ["dovecote:notify"]);
  const env = makeEnv({ OAUTH_KV: kv as any });

  const creds = await getCsrfCredentials(env, "dovecote:admin");
  const res = await postAuthorize(env, { ...creds, scope: "dovecote:admin", username: "alice", password: "correct" });
  expect(res.status).toBe(403);
  expect(await res.text()).toContain("Insufficient scope");
});

test("Contract G: admin user with dovecote:admin scope + scope=admin → 302 userId=admin", async () => {
  const kv = new MockKV();
  await seedUser(kv, "admin", "adminpass", ["dovecote:notify", "dovecote:admin"]);
  const env = makeEnv({ OAUTH_KV: kv as any });
  lastCompleteAuthCall = null;

  const creds = await getCsrfCredentials(env, "dovecote:admin");
  const res = await postAuthorize(env, { ...creds, scope: "dovecote:admin", username: "admin", password: "adminpass" });
  expect(res.status).toBe(302);
  expect(lastCompleteAuthCall.userId).toBe("admin");
  expect(lastCompleteAuthCall.scope).toEqual(["dovecote:admin"]);
});

test("Contract G: empty KV + OAUTH_PASSWORD legacy + operator + scope=notify → 302 userId=operator", async () => {
  const env = makeEnv({ OAUTH_PASSWORD: "legacy-pass" });
  lastCompleteAuthCall = null;

  const creds = await getCsrfCredentials(env, "dovecote:notify");
  const res = await postAuthorize(env, { ...creds, scope: "dovecote:notify", username: "operator", password: "legacy-pass" });
  expect(res.status).toBe(302);
  expect(lastCompleteAuthCall.userId).toBe("operator");
  expect(lastCompleteAuthCall.scope).toEqual(["dovecote:notify"]);
});

test("Contract G: missing username form field → 403", async () => {
  const env = makeEnv({ OAUTH_PASSWORD: "legacy-pass" });
  const creds = await getCsrfCredentials(env, "dovecote:notify");
  const res = await postAuthorize(env, { ...creds, scope: "dovecote:notify", omitUsername: true, password: "legacy-pass" });
  expect(res.status).toBe(403);
});

// ---------------------------------------------------------------------------
// Contract C: GET form contains username + password and username precedes password
// ---------------------------------------------------------------------------

test("Contract C: form has username input before password input", async () => {
  const env = makeEnv();
  const res = await authorizeApp.fetch(new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://example.com&state=xyz&response_type=code&scope=dovecote:notify"), env);
  const html = await res.text();
  expect(html).toContain('name="username"');
  expect(html).toContain('name="password"');
  expect(html).toContain('name="csrf_token"');
  expect(html.indexOf('name="username"')).toBeLessThan(html.indexOf('name="password"'));
});
