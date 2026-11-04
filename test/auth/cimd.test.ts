import { test, expect, afterEach, beforeEach } from "bun:test";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import app from "../../src/index.js";
import { issueToken, revokeToken } from "../../src/auth/api-token.js";
import type { Env } from "../../src/types.js";
import { MockKV } from "../helpers/mock-kv.js";
import { createMockExecutionCtx } from "../helpers/mock-execution-ctx.js";
import { runFormOAuthFlow } from "../helpers/form-oauth.js";
import { generateCodeChallenge, generateCodeVerifier } from "../helpers/pkce.js";

// Claude's two Client ID Metadata Documents sign in without pre-registration,
// driven through the real provider with the document fetch stubbed.

const BASE = "https://example.com";
const CLAUDE_AI = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const CLAUDE_CODE = "https://claude.ai/oauth/claude-code-client-metadata";
const CLAUDE_AI_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

// The bodies Claude serves (fetched 2026-11-04).
const DOCUMENTS: Record<string, object> = {
  [CLAUDE_AI]: {
    client_id: CLAUDE_AI,
    client_name: "Claude",
    client_uri: "https://claude.ai",
    redirect_uris: [CLAUDE_AI_REDIRECT],
    grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  },
  [CLAUDE_CODE]: {
    client_id: CLAUDE_CODE,
    client_name: "Claude Code",
    client_uri: "https://claude.ai",
    redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  },
};

const originalFetch = globalThis.fetch;
const g = globalThis as { Cloudflare?: unknown };
const originalCloudflare = g.Cloudflare;
let fetched: string[] = [];

function serveDocuments(respond: (url: string) => Response = (url) => Response.json(DOCUMENTS[url])) {
  globalThis.fetch = (async (input: Request | string | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    fetched.push(url);
    return respond(url);
  }) as typeof fetch;
}

beforeEach(() => {
  fetched = [];
  // workerd exposes the Worker's compatibility flags here; the provider reads
  // global_fetch_strictly_public from it before it fetches a document.
  g.Cloudflare = { compatibilityFlags: { global_fetch_strictly_public: true } };
  serveDocuments();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  g.Cloudflare = originalCloudflare;
});

function makeEnv(): Env {
  return {
    OAUTH_KV: new MockKV() as any,
    HMAC_PEPPER: "test-pepper",
    ADMIN_REVOKE_TOKEN: "admin-token-123",
    ENABLE_CLIENT_BOOTSTRAP: "1",
  };
}

function fetcher(env: Env) {
  return (req: Request) => Promise.resolve(app.fetch(req, env, createMockExecutionCtx() as any));
}

async function authorizeQuery(clientId: string, redirectUri: string): Promise<URLSearchParams> {
  return new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state: "s",
    code_challenge: await generateCodeChallenge(generateCodeVerifier()),
    code_challenge_method: "S256",
  });
}

function toolsList(accessToken: string): Request {
  return new Request(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

function tokenRequest(form: Record<string, string>, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form).toString(),
  });
}

async function expectRefusedWithoutRedirect(res: Response, error: string, status = 400) {
  expect(res.status).toBe(status);
  expect(res.headers.get("Location")).toBeNull();
  expect(((await res.json()) as { error: string }).error).toBe(error);
}

test("the claude.ai document signs in, serves /mcp, and binds the grant to the pasted dvct token", async () => {
  const env = makeEnv();
  const doFetch = fetcher(env);
  const { accessToken, tokenId } = await runFormOAuthFlow({
    doFetch,
    env,
    clientId: CLAUDE_AI,
    redirectUri: CLAUDE_AI_REDIRECT,
    scope: "dovecote:notify",
    state: "s",
    userId: "alice",
    baseUrl: BASE,
  });
  expect(fetched.length).toBeGreaterThan(0);
  expect(fetched.every((url) => url === CLAUDE_AI)).toBe(true);
  expect((await doFetch(toolsList(accessToken))).status).toBe(200);

  const noop = { fetch: () => new Response(null, { status: 404 }) };
  const grants = await getOAuthApi(
    {
      apiHandler: noop,
      apiRoute: "/mcp",
      defaultHandler: noop,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      resourceMetadata: { resource: `${BASE}/mcp` },
    },
    env,
  ).listUserGrants("alice");
  expect(grants.items).toHaveLength(1);
  expect(grants.items[0]!.clientId).toBe(CLAUDE_AI);
  expect(grants.items[0]!.metadata).toMatchObject({ tokenId });

  expect((await revokeToken({ tokenId, env }, env)).revoked).toBe(true);
  expect((await doFetch(toolsList(accessToken))).status).toBe(401);
});

test("a CIMD grant cannot be refreshed once its bound dvct token is revoked", async () => {
  const env = makeEnv();
  const doFetch = fetcher(env);
  const { refreshToken, tokenId } = await runFormOAuthFlow({
    doFetch,
    env,
    clientId: CLAUDE_AI,
    redirectUri: CLAUDE_AI_REDIRECT,
    scope: "dovecote:notify",
    state: "s",
    baseUrl: BASE,
  });
  const refresh = () =>
    doFetch(tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken!, client_id: CLAUDE_AI }));
  expect((await revokeToken({ tokenId, env }, env)).revoked).toBe(true);
  const res = await refresh();
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
});

test("the Claude Code document signs in on an ephemeral 127.0.0.1 port", async () => {
  const env = makeEnv();
  const doFetch = fetcher(env);
  const { accessToken } = await runFormOAuthFlow({
    doFetch,
    env,
    clientId: CLAUDE_CODE,
    redirectUri: "http://127.0.0.1:53017/callback",
    scope: "dovecote:notify",
    state: "s",
    baseUrl: BASE,
  });
  expect((await doFetch(toolsList(accessToken))).status).toBe(200);
});

test("a redirect_uri the document does not list is refused without a redirect", async () => {
  const query = await authorizeQuery(CLAUDE_AI, "https://evil.example/callback");
  const res = await fetcher(makeEnv())(new Request(`${BASE}/authorize?${query}`));
  await expectRefusedWithoutRedirect(res, "invalid_redirect_uri");
});

// Near-misses of an allowlisted URL, and URLs a looser guard would not read as
// URLs. Each would make the provider fetch something other than an allowlisted
// document, or refuse it in its own validation instead of the guard.
const NEAR_MISSES = [
  "HTTPS://claude.ai/oauth/mcp-oauth-client-metadata",
  "https://claude.ai/OAUTH/MCP-OAUTH-CLIENT-METADATA",
  "https://claude.ai/oauth/mcp-oauth-client-metadata/",
  "https://claude.ai/oauth/claude-code-client-metadata/",
  "https://claude.ai/oauth/mcp-oauth-client-metadata?x=1",
  "https://claude.ai/oauth/mcp-oauth-client-metadata#frag",
  "https://claude.ai:443/oauth/mcp-oauth-client-metadata",
  "https://claude.ai/oauth/mcp-oauth-client-metadata-evil",
  "https://claude.ai@evil.example/oauth/mcp-oauth-client-metadata",
  "HTTPS://evil.example/x",
  "HtTpS://evil.example/x",
  "https://evil.example/client.json",
];
const GUARD_AUTHORIZE = "client_id is not an accepted client metadata document URL";
const GUARD_TOKEN = "Client authentication failed";

async function expectGuardRefusal(res: Response, status: number, description: string) {
  expect(fetched).toEqual([]);
  expect(res.status).toBe(status);
  expect(res.headers.get("Location")).toBeNull();
  expect(await res.json()).toEqual({ error: "invalid_client", error_description: description });
}

// A fresh env per request, so the /authorize rate limit never answers first.
for (const clientId of NEAR_MISSES) {
  test(`GET /authorize refuses ${clientId} before any fetch`, async () => {
    const query = await authorizeQuery(clientId, CLAUDE_AI_REDIRECT);
    const res = await fetcher(makeEnv())(new Request(`${BASE}/authorize?${query}`));
    await expectGuardRefusal(res, 400, GUARD_AUTHORIZE);
  });

  test(`POST /authorize refuses ${clientId} before any fetch`, async () => {
    const body = await authorizeQuery(clientId, CLAUDE_AI_REDIRECT);
    body.set("token", "dvct_whatever");
    const res = await fetcher(makeEnv())(
      new Request(`${BASE}/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
    );
    await expectGuardRefusal(res, 400, GUARD_AUTHORIZE);
  });

  test(`/token refuses ${clientId} in the body before any fetch`, async () => {
    const res = await fetcher(makeEnv())(
      tokenRequest({ grant_type: "authorization_code", code: "x", client_id: clientId }),
    );
    await expectGuardRefusal(res, 401, GUARD_TOKEN);
  });

  test(`/token refuses ${clientId} in a Basic header before any fetch`, async () => {
    const res = await fetcher(makeEnv())(
      tokenRequest(
        { grant_type: "authorization_code", code: "x" },
        { Authorization: `Basic ${btoa(`${encodeURIComponent(clientId)}:secret`)}` },
      ),
    );
    await expectGuardRefusal(res, 401, GUARD_TOKEN);
    expect(res.headers.get("WWW-Authenticate")).toBe('Basic realm="OAuth"');
  });
}

// A guard that reads only the first or only the last of repeated client_ids
// would miss a URL the provider still resolves: it drops empty values at
// /token and takes the first value at /authorize.
const EVIL = "https://evil.example/client.json";
const REPEATS: Array<[string, string[]]> = [
  ["empty then URL", ["", EVIL]],
  ["URL then empty", [EVIL, ""]],
];
for (const [name, ids] of REPEATS) {
  test(`/token refuses a repeated client_id (${name})`, async () => {
    const body = new URLSearchParams([["grant_type", "authorization_code"], ["code", "x"]]);
    for (const id of ids) body.append("client_id", id);
    const res = await fetcher(makeEnv())(
      new Request(`${BASE}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
    );
    await expectGuardRefusal(res, 401, GUARD_TOKEN);
  });
}

const AUTHORIZE_REPEATS: Array<[string, string[]]> = [
  ["URL then allowlisted", [EVIL, CLAUDE_AI]],
  ["allowlisted then URL", [CLAUDE_AI, EVIL]],
];
for (const [name, ids] of AUTHORIZE_REPEATS) {
  test(`GET /authorize refuses a repeated client_id (${name})`, async () => {
    const query = await authorizeQuery(ids[0]!, CLAUDE_AI_REDIRECT);
    query.append("client_id", ids[1]!);
    const res = await fetcher(makeEnv())(new Request(`${BASE}/authorize?${query}`));
    await expectGuardRefusal(res, 400, GUARD_AUTHORIZE);
  });

  test(`POST /authorize refuses a repeated client_id (${name})`, async () => {
    const body = await authorizeQuery(ids[0]!, CLAUDE_AI_REDIRECT);
    body.append("client_id", ids[1]!);
    body.set("token", "dvct_whatever");
    const res = await fetcher(makeEnv())(
      new Request(`${BASE}/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
    );
    await expectGuardRefusal(res, 400, GUARD_AUTHORIZE);
  });
}

test("/token refuses Basic header shapes and client assertions the provider still decodes", async () => {
  const doFetch = fetcher(makeEnv());
  const evil = "https://evil.example/client.json";
  // Header shapes the provider still decodes: JS trim() strips the \v, atob drops the \f.
  const credentials = btoa(`${encodeURIComponent(evil)}:secret`);
  for (const header of [`Basic \v${credentials}`, `Basic ${credentials.slice(0, 8)}\f${credentials.slice(8)}`]) {
    const res = await doFetch(tokenRequest({ grant_type: "authorization_code", code: "x" }, { Authorization: header }));
    await expectRefusedWithoutRedirect(res, "invalid_client", 401);
  }
  const b64url = (json: object) => btoa(JSON.stringify(json)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const viaAssertion = await doFetch(
    tokenRequest({
      grant_type: "authorization_code",
      code: "x",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({ iss: evil, sub: evil, aud: `${BASE}/token` })}.c2ln`,
    }),
  );
  await expectRefusedWithoutRedirect(viaAssertion, "invalid_client", 401);
  expect(fetched).toEqual([]);
});

test("an allowlisted document that answers 500 is a clean JSON error without a redirect", async () => {
  serveDocuments(() => new Response("boom", { status: 500 }));
  const query = await authorizeQuery(CLAUDE_AI, CLAUDE_AI_REDIRECT);
  const res = await fetcher(makeEnv())(new Request(`${BASE}/authorize?${query}`));
  await expectRefusedWithoutRedirect(res, "invalid_client");
  expect(fetched).toEqual([CLAUDE_AI]);
});

test("an allowlisted document that is not JSON is a clean JSON error without a redirect", async () => {
  serveDocuments(() => new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } }));
  const query = await authorizeQuery(CLAUDE_AI, CLAUDE_AI_REDIRECT);
  const res = await fetcher(makeEnv())(new Request(`${BASE}/authorize?${query}`));
  await expectRefusedWithoutRedirect(res, "invalid_client");
});

test("a document that stops resolving between the form and the grant is a clean JSON error", async () => {
  // POST /authorize resolves the document twice: parseAuthRequest re-validates
  // the hidden fields, then completeAuthorization looks the client up again.
  let calls = 0;
  serveDocuments((url) => (++calls === 1 ? Response.json(DOCUMENTS[url]) : new Response("boom", { status: 500 })));
  const env = makeEnv();
  const { token } = await issueToken({ userId: "alice", scopes: ["dovecote:notify"] }, env);
  const body = await authorizeQuery(CLAUDE_AI, CLAUDE_AI_REDIRECT);
  body.set("token", token);
  const res = await fetcher(env)(
    new Request(`${BASE}/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }),
  );
  await expectRefusedWithoutRedirect(res, "invalid_client");
  expect(fetched).toEqual([CLAUDE_AI, CLAUDE_AI]);
});

test("authorization server metadata advertises Client ID Metadata Document support", async () => {
  const res = await fetcher(makeEnv())(new Request(`${BASE}/.well-known/oauth-authorization-server`));
  const json = (await res.json()) as Record<string, unknown>;
  expect(json.client_id_metadata_document_supported).toBe(true);
  expect(json.registration_endpoint).toBeUndefined();
});
