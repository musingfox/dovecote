import { test, expect, spyOn, afterEach } from "bun:test";
import authorizeApp from "../../src/auth/authorize.js";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../../src/types.js";
import { SCOPES_SUPPORTED, SCOPE_DESCRIPTIONS } from "../../src/auth/scopes.js";

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

const mockOAuthProvider: OAuthHelpers = {
  parseAuthRequest: async () => mockAuthRequest,
  completeAuthorization: async (params: any) => {
    // Validate that props contains userId and scopes
    if (!params.props || !params.props.userId || !params.props.scopes) {
      throw new Error("Missing required props");
    }
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

interface AuthEnv extends Env {
  OAUTH_PROVIDER: OAuthHelpers;
}

const mockEnv: AuthEnv = {
  OAUTH_KV: {
    put: async () => {},
    get: async () => null,
    delete: async () => {},
    list: async () => ({ keys: [], list_complete: true }),
  } as any,
  OAUTH_PASSWORD: "correct-password",
  OAUTH_ADMIN_PASSWORD: "admin-password",
  COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length",
  OAUTH_PROVIDER: mockOAuthProvider,
  TELEGRAM_INSTANCES: undefined,
  DISCORD_INSTANCES: undefined,
};

test("GET /authorize returns 200 with authorization form", async () => {
  const url = new URL("https://example.com/authorize");
  url.searchParams.set("client_id", "abc");
  url.searchParams.set("redirect_uri", "https://claude.ai/api/mcp/auth_callback");
  url.searchParams.set("state", "xyz");
  url.searchParams.set("code_challenge", "abc123");
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", "dovecote:notify");
  url.searchParams.set("response_type", "code");

  const req = new Request(url.toString());
  const res = await authorizeApp.fetch(req, mockEnv);

  expect(res.status).toBe(200);

  const html = await res.text();
  expect(html).toContain("<form");
  expect(html).toContain('name="password"');
  expect(html).toContain('name="csrf_token"');
  expect(html).toContain('value="abc"');

  // Check for Set-Cookie header
  const setCookie = res.headers.get("Set-Cookie");
  expect(setCookie).toBeTruthy();
  expect(setCookie).toContain("csrf=");
});

test("POST /authorize with correct password and valid CSRF returns 302", async () => {
  // First, get the CSRF token
  const getReq = new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://claude.ai/api/mcp/auth_callback&state=xyz&code_challenge=abc&code_challenge_method=S256&scope=dovecote:notify&response_type=code");
  const getRes = await authorizeApp.fetch(getReq, mockEnv);

  const html = await getRes.text();
  const csrfMatch = html.match(/name="csrf_token" value="([^"]+)"/);
  expect(csrfMatch).toBeTruthy();
  const csrfToken = csrfMatch![1]!;

  const setCookie = getRes.headers.get("Set-Cookie");
  expect(setCookie).toBeTruthy();
  const cookieMatch = setCookie!.match(/csrf=([^;]+)/);
  expect(cookieMatch).toBeTruthy();
  const cookieValue = cookieMatch![1]!;

  // Now POST with the CSRF token
  const formData = new FormData();
  formData.append("csrf_token", csrfToken);
  formData.append("password", "correct-password");
  formData.append("response_type", "code");
  formData.append("client_id", "abc");
  formData.append("redirect_uri", "https://claude.ai/api/mcp/auth_callback");
  formData.append("state", "xyz");
  formData.append("scope", "dovecote:notify");
  formData.append("code_challenge", "abc");
  formData.append("code_challenge_method", "S256");

  const postReq = new Request("https://example.com/authorize", {
    method: "POST",
    headers: {
      Cookie: `csrf=${cookieValue}`,
    },
    body: formData,
  });

  const postRes = await authorizeApp.fetch(postReq, mockEnv);
  expect(postRes.status).toBe(302);

  const location = postRes.headers.get("Location");
  expect(location).toBeTruthy();
  expect(location).toContain("code=");
  expect(location).toContain("state=xyz");
});

test("POST /authorize with wrong password returns 403", async () => {
  // Get CSRF token first
  const getReq = new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://claude.ai/api/mcp/auth_callback&state=xyz&code_challenge=abc&code_challenge_method=S256&scope=dovecote:notify&response_type=code");
  const getRes = await authorizeApp.fetch(getReq, mockEnv);

  const html = await getRes.text();
  const csrfMatch = html.match(/name="csrf_token" value="([^"]+)"/);
  const csrfToken = csrfMatch![1]!;

  const setCookie = getRes.headers.get("Set-Cookie");
  const cookieMatch = setCookie!.match(/csrf=([^;]+)/);
  const cookieValue = cookieMatch![1]!;

  // POST with wrong password
  const formData = new FormData();
  formData.append("csrf_token", csrfToken);
  formData.append("password", "wrong-password");
  formData.append("response_type", "code");
  formData.append("client_id", "abc");
  formData.append("redirect_uri", "https://claude.ai/api/mcp/auth_callback");
  formData.append("state", "xyz");
  formData.append("scope", "dovecote:notify");

  const postReq = new Request("https://example.com/authorize", {
    method: "POST",
    headers: {
      Cookie: `csrf=${cookieValue}`,
    },
    body: formData,
  });

  const postRes = await authorizeApp.fetch(postReq, mockEnv);
  expect(postRes.status).toBe(403);
  expect(await postRes.text()).toContain("Invalid password");
});

test("POST /authorize with correct password but invalid CSRF returns 403", async () => {
  const formData = new FormData();
  formData.append("csrf_token", "fake-token");
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

  const postRes = await authorizeApp.fetch(postReq, mockEnv);
  expect(postRes.status).toBe(403);
  expect(await postRes.text()).toContain("Invalid CSRF token");
});

/**
 * Helper function to simulate scope filtering logic
 * Extracted for unit testing without mounting full OAuth provider
 */
function filterScopes(scope: string): string[] {
  const requestedScopes = scope.split(" ");
  return requestedScopes.filter((s) =>
    (SCOPES_SUPPORTED as readonly string[]).includes(s)
  );
}

test("authorize scope filter: both supported scopes", () => {
  const scope = "dovecote:notify dovecote:env:read";
  const effectiveScopes = filterScopes(scope);

  expect(effectiveScopes).toEqual(["dovecote:notify", "dovecote:env:read"]);
});

test("authorize scope filter: one supported, one unsupported", () => {
  const scope = "dovecote:notify admin:delete";
  const effectiveScopes = filterScopes(scope);

  expect(effectiveScopes).toEqual(["dovecote:notify"]);
});

test("authorize scope filter: no supported scopes", () => {
  const scope = "admin:delete";
  const effectiveScopes = filterScopes(scope);

  expect(effectiveScopes).toEqual([]);
});

test("authorize scope filter: empty string", () => {
  const scope = "";
  const effectiveScopes = filterScopes(scope);

  // split("") produces [""], filter drops it
  expect(effectiveScopes).toEqual([]);
});

// Contract 1: SCOPE_DESCRIPTIONS unit tests
test("SCOPE_DESCRIPTIONS contains dovecote:notify with correct description", () => {
  expect(SCOPE_DESCRIPTIONS["dovecote:notify"].description).toBe("傳送通知訊息至已連結的頻道");
});

test("SCOPE_DESCRIPTIONS dovecote:notify has no warning", () => {
  expect(SCOPE_DESCRIPTIONS["dovecote:notify"].warning).toBeUndefined();
});

test("SCOPE_DESCRIPTIONS contains dovecote:env:read with correct description", () => {
  expect(SCOPE_DESCRIPTIONS["dovecote:env:read"].description).toBe("讀取環境變數設定檔");
});

test("SCOPE_DESCRIPTIONS dovecote:env:read has correct warning", () => {
  expect(SCOPE_DESCRIPTIONS["dovecote:env:read"].warning).toBe("此授權允許讀取完整環境變數");
});

// Contract 2: GET handler scope validation
test("GET /authorize with valid scope dovecote:notify returns 200", async () => {
  const customMockProvider: OAuthHelpers = {
    ...mockOAuthProvider,
    parseAuthRequest: async () => ({
      ...mockAuthRequest,
      scope: ["dovecote:notify"],
    }),
  };

  const customEnv: AuthEnv = {
    ...mockEnv,
    OAUTH_PROVIDER: customMockProvider,
  };

  const req = new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://example.com&state=xyz&response_type=code&scope=dovecote:notify");
  const res = await authorizeApp.fetch(req, customEnv);

  expect(res.status).toBe(200);
});

test("GET /authorize with valid scopes dovecote:notify and dovecote:env:read returns 200", async () => {
  const customMockProvider: OAuthHelpers = {
    ...mockOAuthProvider,
    parseAuthRequest: async () => ({
      ...mockAuthRequest,
      scope: ["dovecote:notify", "dovecote:env:read"],
    }),
  };

  const customEnv: AuthEnv = {
    ...mockEnv,
    OAUTH_PROVIDER: customMockProvider,
  };

  const req = new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://example.com&state=xyz&response_type=code&scope=dovecote:notify%20dovecote:env:read");
  const res = await authorizeApp.fetch(req, customEnv);

  expect(res.status).toBe(200);
});

test("GET /authorize with dovecote:admin returns 200 and renders description and warning", async () => {
  const customMockProvider: OAuthHelpers = {
    ...mockOAuthProvider,
    parseAuthRequest: async () => ({
      ...mockAuthRequest,
      scope: ["dovecote:admin"],
    }),
  };

  const customEnv: AuthEnv = {
    ...mockEnv,
    OAUTH_PROVIDER: customMockProvider,
  };

  const req = new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://example.com&state=xyz&response_type=code&scope=dovecote:admin");
  const res = await authorizeApp.fetch(req, customEnv);

  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("dovecote:admin");
  expect(html).toContain("執行 admin 等級操作");
  expect(html).toContain('<div class="scope-warning">');
});

test("GET /authorize with mixed valid and invalid scope returns 400", async () => {
  const customMockProvider: OAuthHelpers = {
    ...mockOAuthProvider,
    parseAuthRequest: async () => ({
      ...mockAuthRequest,
      scope: ["dovecote:notify", "foo:bar"],
    }),
  };

  const customEnv: AuthEnv = {
    ...mockEnv,
    OAUTH_PROVIDER: customMockProvider,
  };

  const req = new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://example.com&state=xyz&response_type=code&scope=dovecote:notify%20foo:bar");
  const res = await authorizeApp.fetch(req, customEnv);

  expect(res.status).toBe(400);
});

test("GET /authorize with empty scope array returns 200", async () => {
  const customMockProvider: OAuthHelpers = {
    ...mockOAuthProvider,
    parseAuthRequest: async () => ({
      ...mockAuthRequest,
      scope: [],
    }),
  };

  const customEnv: AuthEnv = {
    ...mockEnv,
    OAUTH_PROVIDER: customMockProvider,
  };

  const req = new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://example.com&state=xyz&response_type=code");
  const res = await authorizeApp.fetch(req, customEnv);

  expect(res.status).toBe(200);
});

// Contract 3: Per-scope rendering in HTML
test("GET /authorize with dovecote:notify shows description but no warning", async () => {
  const customMockProvider: OAuthHelpers = {
    ...mockOAuthProvider,
    parseAuthRequest: async () => ({
      ...mockAuthRequest,
      scope: ["dovecote:notify"],
    }),
  };

  const customEnv: AuthEnv = {
    ...mockEnv,
    OAUTH_PROVIDER: customMockProvider,
  };

  const req = new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://example.com&state=xyz&response_type=code&scope=dovecote:notify");
  const res = await authorizeApp.fetch(req, customEnv);

  const html = await res.text();
  expect(html).toContain("傳送通知訊息至已連結的頻道");
  expect(html).not.toContain('<div class="scope-warning">');
});

test("GET /authorize with dovecote:env:read shows warning", async () => {
  const customMockProvider: OAuthHelpers = {
    ...mockOAuthProvider,
    parseAuthRequest: async () => ({
      ...mockAuthRequest,
      scope: ["dovecote:env:read"],
    }),
  };

  const customEnv: AuthEnv = {
    ...mockEnv,
    OAUTH_PROVIDER: customMockProvider,
  };

  const req = new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://example.com&state=xyz&response_type=code&scope=dovecote:env:read");
  const res = await authorizeApp.fetch(req, customEnv);

  const html = await res.text();
  expect(html).toContain('<div class="scope-warning">此授權允許讀取完整環境變數</div>');
});

test("GET /authorize with both scopes shows both descriptions and warning appears once", async () => {
  const customMockProvider: OAuthHelpers = {
    ...mockOAuthProvider,
    parseAuthRequest: async () => ({
      ...mockAuthRequest,
      scope: ["dovecote:notify", "dovecote:env:read"],
    }),
  };

  const customEnv: AuthEnv = {
    ...mockEnv,
    OAUTH_PROVIDER: customMockProvider,
  };

  const req = new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://example.com&state=xyz&response_type=code&scope=dovecote:notify%20dovecote:env:read");
  const res = await authorizeApp.fetch(req, customEnv);

  const html = await res.text();
  expect(html).toContain("傳送通知訊息至已連結的頻道");
  expect(html).toContain("讀取環境變數設定檔");

  // Count occurrences of scope-warning
  const warningMatches = html.match(/scope-warning/g);
  expect(warningMatches).not.toBeNull();
  expect(warningMatches?.length).toBe(2); // One in CSS, one in HTML
});

// Contract 3: Snapshot tests
test("GET /authorize HTML snapshot for dovecote:notify", async () => {
  const customMockProvider: OAuthHelpers = {
    ...mockOAuthProvider,
    parseAuthRequest: async () => ({
      ...mockAuthRequest,
      scope: ["dovecote:notify"],
    }),
  };

  const customEnv: AuthEnv = {
    ...mockEnv,
    OAUTH_PROVIDER: customMockProvider,
  };

  const req = new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://example.com&state=xyz&response_type=code&scope=dovecote:notify");
  const res = await authorizeApp.fetch(req, customEnv);

  const html = await res.text();
  // Normalize CSRF token for snapshot stability
  const normalizedHtml = html.replace(/name="csrf_token" value="[^"]+"/g, 'name="csrf_token" value="NORMALIZED_CSRF_TOKEN"');
  expect(normalizedHtml).toMatchSnapshot("dovecote:notify");
});

test("GET /authorize HTML snapshot for dovecote:env:read", async () => {
  const customMockProvider: OAuthHelpers = {
    ...mockOAuthProvider,
    parseAuthRequest: async () => ({
      ...mockAuthRequest,
      scope: ["dovecote:env:read"],
    }),
  };

  const customEnv: AuthEnv = {
    ...mockEnv,
    OAUTH_PROVIDER: customMockProvider,
  };

  const req = new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://example.com&state=xyz&response_type=code&scope=dovecote:env:read");
  const res = await authorizeApp.fetch(req, customEnv);

  const html = await res.text();
  // Normalize CSRF token for snapshot stability
  const normalizedHtml = html.replace(/name="csrf_token" value="[^"]+"/g, 'name="csrf_token" value="NORMALIZED_CSRF_TOKEN"');
  expect(normalizedHtml).toMatchSnapshot("dovecote:env:read");
});

test("GET /authorize HTML snapshot for both scopes", async () => {
  const customMockProvider: OAuthHelpers = {
    ...mockOAuthProvider,
    parseAuthRequest: async () => ({
      ...mockAuthRequest,
      scope: ["dovecote:notify", "dovecote:env:read"],
    }),
  };

  const customEnv: AuthEnv = {
    ...mockEnv,
    OAUTH_PROVIDER: customMockProvider,
  };

  const req = new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://example.com&state=xyz&response_type=code&scope=dovecote:notify%20dovecote:env:read");
  const res = await authorizeApp.fetch(req, customEnv);

  const html = await res.text();
  // Normalize CSRF token for snapshot stability
  const normalizedHtml = html.replace(/name="csrf_token" value="[^"]+"/g, 'name="csrf_token" value="NORMALIZED_CSRF_TOKEN"');
  expect(normalizedHtml).toMatchSnapshot("both-scopes");
});

// Contract 4: Security headers
test("GET /authorize 200 response includes Content-Security-Policy header", async () => {
  const req = new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://example.com&state=xyz&response_type=code&scope=dovecote:notify");
  const res = await authorizeApp.fetch(req, mockEnv);

  expect(res.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
});

test("GET /authorize 200 response includes X-Frame-Options header", async () => {
  const req = new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://example.com&state=xyz&response_type=code&scope=dovecote:notify");
  const res = await authorizeApp.fetch(req, mockEnv);

  expect(res.headers.get("X-Frame-Options")).toBe("DENY");
});

test("GET /authorize 200 response includes Referrer-Policy header", async () => {
  const req = new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://example.com&state=xyz&response_type=code&scope=dovecote:notify");
  const res = await authorizeApp.fetch(req, mockEnv);

  expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
});

test("GET /authorize 400 invalid scope includes all security headers", async () => {
  const customMockProvider: OAuthHelpers = {
    ...mockOAuthProvider,
    parseAuthRequest: async () => ({
      ...mockAuthRequest,
      scope: ["foo:bar"],
    }),
  };

  const customEnv: AuthEnv = {
    ...mockEnv,
    OAUTH_PROVIDER: customMockProvider,
  };

  const req = new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://example.com&state=xyz&response_type=code&scope=foo:bar");
  const res = await authorizeApp.fetch(req, customEnv);

  expect(res.status).toBe(400);
  expect(res.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
  expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
});

// ---------------------------------------------------------------------------
// Helper: get CSRF token + cookie for POST tests
// ---------------------------------------------------------------------------
async function getCsrfCredentials(env: AuthEnv, scope: string): Promise<{ csrfToken: string; cookieValue: string }> {
  const getRes = await authorizeApp.fetch(
    new Request(`https://example.com/authorize?client_id=abc&redirect_uri=https://claude.ai/api/mcp/auth_callback&state=xyz&code_challenge=abc&code_challenge_method=S256&scope=${encodeURIComponent(scope)}&response_type=code`),
    env
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
  { csrfToken, cookieValue, scope, password }: { csrfToken: string; cookieValue: string; scope: string; password: string }
): Promise<Response> {
  const formData = new FormData();
  formData.append("csrf_token", csrfToken);
  formData.append("password", password);
  formData.append("response_type", "code");
  formData.append("client_id", "abc");
  formData.append("redirect_uri", "https://claude.ai/api/mcp/auth_callback");
  formData.append("state", "xyz");
  formData.append("scope", scope);
  formData.append("code_challenge", "abc");
  formData.append("code_challenge_method", "S256");

  return authorizeApp.fetch(
    new Request("https://example.com/authorize", {
      method: "POST",
      headers: { Cookie: `csrf=${cookieValue}` },
      body: formData,
    }),
    env
  );
}

// ---------------------------------------------------------------------------
// Contract B: dovecote:admin is a supported scope
// ---------------------------------------------------------------------------

test("Contract B: SCOPES_SUPPORTED includes dovecote:admin", () => {
  expect((SCOPES_SUPPORTED as readonly string[]).includes("dovecote:admin")).toBe(true);
});

test("Contract B: SCOPE_DESCRIPTIONS[dovecote:admin].description is non-empty", () => {
  expect(SCOPE_DESCRIPTIONS["dovecote:admin"].description).toBeTruthy();
  expect(SCOPE_DESCRIPTIONS["dovecote:admin"].description.length).toBeGreaterThan(0);
});

test("Contract B: SCOPE_DESCRIPTIONS[dovecote:admin].warning is non-empty", () => {
  expect(SCOPE_DESCRIPTIONS["dovecote:admin"].warning).toBeTruthy();
  expect(SCOPE_DESCRIPTIONS["dovecote:admin"].warning!.length).toBeGreaterThan(0);
});

test("Contract B: filterScopes retains dovecote:admin alongside dovecote:notify", () => {
  const result = filterScopes("dovecote:notify dovecote:admin");
  expect(result).toEqual(["dovecote:notify", "dovecote:admin"]);
});

test("Contract B: GET /authorize with dovecote:admin mixed invalid scope returns 400", async () => {
  const customMockProvider: OAuthHelpers = {
    ...mockOAuthProvider,
    parseAuthRequest: async () => ({
      ...mockAuthRequest,
      scope: ["dovecote:admin", "foo:bar"],
    }),
  };

  const customEnv: AuthEnv = { ...mockEnv, OAUTH_PROVIDER: customMockProvider };
  const req = new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://example.com&state=xyz&response_type=code&scope=dovecote:admin%20foo:bar");
  const res = await authorizeApp.fetch(req, customEnv);

  expect(res.status).toBe(400);
  const body = await res.text();
  expect(body).toContain("Invalid scope requested");
});

// ---------------------------------------------------------------------------
// Contract A: POST /authorize dispatches to admin password when admin scope present
// ---------------------------------------------------------------------------

test("Contract A: admin scope + admin password → 302", async () => {
  const creds = await getCsrfCredentials(mockEnv, "dovecote:admin");
  const res = await postAuthorize(mockEnv, { ...creds, scope: "dovecote:admin", password: "admin-password" });
  expect(res.status).toBe(302);
  const location = res.headers.get("Location");
  expect(location).toContain("code=");
  expect(location).toContain("state=xyz");
});

test("Contract A: admin scope + regular password → 403", async () => {
  const creds = await getCsrfCredentials(mockEnv, "dovecote:admin");
  const res = await postAuthorize(mockEnv, { ...creds, scope: "dovecote:admin", password: "correct-password" });
  expect(res.status).toBe(403);
  expect(await res.text()).toContain("Invalid password");
});

test("Contract A: mixed scope (notify+admin) + admin password → 302", async () => {
  const creds = await getCsrfCredentials(mockEnv, "dovecote:notify dovecote:admin");
  const res = await postAuthorize(mockEnv, { ...creds, scope: "dovecote:notify dovecote:admin", password: "admin-password" });
  expect(res.status).toBe(302);
});

test("Contract A: mixed scope (notify+admin) + regular password → 403", async () => {
  const creds = await getCsrfCredentials(mockEnv, "dovecote:notify dovecote:admin");
  const res = await postAuthorize(mockEnv, { ...creds, scope: "dovecote:notify dovecote:admin", password: "correct-password" });
  expect(res.status).toBe(403);
  expect(await res.text()).toContain("Invalid password");
});

test("Contract A: non-admin scope + regular password → 302 (non-admin path unchanged)", async () => {
  const creds = await getCsrfCredentials(mockEnv, "dovecote:notify");
  const res = await postAuthorize(mockEnv, { ...creds, scope: "dovecote:notify", password: "correct-password" });
  expect(res.status).toBe(302);
});

test("Contract A: non-admin scope + admin password → 403 (admin secret must NOT authorize non-admin)", async () => {
  const creds = await getCsrfCredentials(mockEnv, "dovecote:notify");
  const res = await postAuthorize(mockEnv, { ...creds, scope: "dovecote:notify", password: "admin-password" });
  expect(res.status).toBe(403);
  expect(await res.text()).toContain("Invalid password");
});

// ---------------------------------------------------------------------------
// Contract C: Missing OAUTH_ADMIN_PASSWORD → 503 fail-closed with console.error
// ---------------------------------------------------------------------------

let consoleErrorSpy: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
  if (consoleErrorSpy) {
    consoleErrorSpy.mockRestore();
    consoleErrorSpy = null;
  }
});

test("Contract C: admin scope + OAUTH_ADMIN_PASSWORD undefined → 503 + console.error", async () => {
  const envWithoutAdmin: AuthEnv = { ...mockEnv, OAUTH_ADMIN_PASSWORD: undefined };
  // Need CSRF from an env that renders the admin form — use mockEnv (has admin password for GET)
  const creds = await getCsrfCredentials(mockEnv, "dovecote:admin");

  consoleErrorSpy = spyOn(console, "error");

  const res = await postAuthorize(envWithoutAdmin, { ...creds, scope: "dovecote:admin", password: "anything" });
  expect(res.status).toBe(503);
  const body = await res.json() as any;
  expect(body.error).toBe("admin authorization not configured");
  expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  const callArgs = consoleErrorSpy.mock.calls[0];
  expect(String(callArgs[0])).toContain("OAUTH_ADMIN_PASSWORD");
});

test("Contract C: admin scope + OAUTH_ADMIN_PASSWORD empty string → 503", async () => {
  const envWithEmptyAdmin: AuthEnv = { ...mockEnv, OAUTH_ADMIN_PASSWORD: "" };
  const creds = await getCsrfCredentials(mockEnv, "dovecote:admin");

  consoleErrorSpy = spyOn(console, "error");

  const res = await postAuthorize(envWithEmptyAdmin, { ...creds, scope: "dovecote:admin", password: "anything" });
  expect(res.status).toBe(503);
  const body = await res.json() as any;
  expect(body.error).toBe("admin authorization not configured");
});

test("Contract C: non-admin scope + OAUTH_ADMIN_PASSWORD undefined → 302 (unaffected)", async () => {
  const envWithoutAdmin: AuthEnv = { ...mockEnv, OAUTH_ADMIN_PASSWORD: undefined };
  const creds = await getCsrfCredentials(envWithoutAdmin, "dovecote:notify");
  const res = await postAuthorize(envWithoutAdmin, { ...creds, scope: "dovecote:notify", password: "correct-password" });
  expect(res.status).toBe(302);
});
