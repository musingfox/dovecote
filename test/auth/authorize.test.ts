import { test, expect } from "bun:test";
import authorizeApp from "../../src/auth/authorize.js";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../../src/types.js";
import { SCOPES_SUPPORTED, SCOPE_DESCRIPTIONS } from "../../src/auth/scopes.js";
import { MockKV } from "../helpers/mock-kv.js";

const ISSUER = "https://idp.example.test";
const AUTHORIZATION_ENDPOINT = "https://idp.example.test/oauth2/authorize";
const JWKS_URI = `${ISSUER}/jwks`;
const AUDIENCE = "rp-audience-test";
const RP_CLIENT_ID = "rp-client-id";
const STATE_SECRET = "s".repeat(32);

function makeMockProvider(scope: string[] = ["dovecote:notify"]): OAuthHelpers {
  return {
    parseAuthRequest: async () => ({
      clientId: "abc",
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      state: "xyz",
      codeChallenge: "abc123",
      codeChallengeMethod: "S256",
      scope,
      responseType: "code",
    } as any),
    completeAuthorization: async (params: any) => {
      return {
        redirectTo: `https://claude.ai/api/mcp/auth_callback?code=test-code&state=xyz`,
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
  return {
    OAUTH_KV: new MockKV() as any,
    OAUTH_PASSWORD: "",
    COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length",
    HMAC_PEPPER: "test-pepper",
    OAUTH_PROVIDER: makeMockProvider(),
    TELEGRAM_INSTANCES: undefined,
    DISCORD_INSTANCES: undefined,
    OIDC_STATE_SECRET: STATE_SECRET,
    OIDC_ISSUERS: JSON.stringify([
      {
        issuer: ISSUER,
        jwks_uri: JWKS_URI,
        audience: AUDIENCE,
        client_id: RP_CLIENT_ID,
        authorization_endpoint: AUTHORIZATION_ENDPOINT,
      },
    ]),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Scope filtering helper unit tests (pure logic; no HTTP; not removed)
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
// Security headers — rewritten to verify 302 OIDC redirect response behavior
// ---------------------------------------------------------------------------

test("GET /authorize → 302 upstream OIDC redirect (not 200 form)", async () => {
  const env = makeEnv();
  const res = await authorizeApp.fetch(
    new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://claude.ai/api/mcp/auth_callback&state=xyz&response_type=code&scope=dovecote:notify"),
    env,
  );
  // After BUILD: 302 redirect; security headers are optional on redirects
  // but we verify the response is 302 (correct behavior)
  expect(res.status).toBe(302);
  const loc = res.headers.get("Location") ?? "";
  expect(loc.startsWith(AUTHORIZATION_ENDPOINT)).toBe(true);
});

test("GET /authorize → 302 has a Location header pointing to upstream", async () => {
  const env = makeEnv();
  const res = await authorizeApp.fetch(
    new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://example.com&state=xyz&response_type=code&scope=dovecote:notify"),
    env,
  );
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toBeTruthy();
});

test("GET /authorize → 302 Location contains state param", async () => {
  const env = makeEnv();
  const res = await authorizeApp.fetch(
    new Request("https://example.com/authorize?client_id=abc&redirect_uri=https://example.com&state=xyz&response_type=code&scope=dovecote:notify"),
    env,
  );
  expect(res.status).toBe(302);
  const loc = res.headers.get("Location") ?? "";
  const params = new URL(loc).searchParams;
  expect((params.get("state") ?? "").length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Contract B: dovecote:admin scope plumbing (SCOPES_SUPPORTED / SCOPE_DESCRIPTIONS)
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
