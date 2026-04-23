import { test, expect } from "bun:test";
import authorizeApp from "../../src/auth/authorize.js";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../../src/types.js";
import { SCOPES_SUPPORTED } from "../../src/auth/scopes.js";

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
  MCP_AUTH_TOKEN: "test-token",
  OAUTH_KV: {
    put: async () => {},
    get: async () => null,
    delete: async () => {},
    list: async () => ({ keys: [], list_complete: true }),
  } as any,
  OAUTH_PASSWORD: "correct-password",
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
  const csrfToken = csrfMatch![1];

  const setCookie = getRes.headers.get("Set-Cookie");
  expect(setCookie).toBeTruthy();
  const cookieMatch = setCookie!.match(/csrf=([^;]+)/);
  expect(cookieMatch).toBeTruthy();
  const cookieValue = cookieMatch![1];

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
  const csrfToken = csrfMatch![1];

  const setCookie = getRes.headers.get("Set-Cookie");
  const cookieMatch = setCookie!.match(/csrf=([^;]+)/);
  const cookieValue = cookieMatch![1];

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
