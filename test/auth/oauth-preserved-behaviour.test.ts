import { test, expect } from "bun:test";
import app from "../../src/index.js";
import { issueToken } from "../../src/auth/api-token.js";
import type { Env } from "../../src/types.js";
import { MockKV } from "../helpers/mock-kv.js";
import { createMockExecutionCtx } from "../helpers/mock-execution-ctx.js";
import { runFormOAuthFlow } from "../helpers/form-oauth.js";
import { generateCodeChallenge, generateCodeVerifier } from "../helpers/pkce.js";

// Behaviour the workers-oauth-provider 1.x upgrade must keep, driven through
// the real provider rather than an OAuthHelpers stub.

const BASE = "https://example.com";

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

async function bootstrapClient(
  doFetch: (r: Request) => Promise<Response>,
  redirectUris: string[],
): Promise<string> {
  const res = await doFetch(
    new Request(`${BASE}/admin/bootstrap-client`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer admin-token-123" },
      body: JSON.stringify({ clientName: "c", redirectUris }),
    }),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { client_id: string }).client_id;
}

test("RFC 8414 metadata is served and advertises only S256 PKCE", async () => {
  const res = await fetcher(makeEnv())(new Request(`${BASE}/.well-known/oauth-authorization-server`));
  expect(res.status).toBe(200);
  const json = (await res.json()) as Record<string, unknown>;
  expect(json.issuer).toBe(BASE);
  expect(json.authorization_endpoint).toBe(`${BASE}/authorize`);
  expect(json.token_endpoint).toBe(`${BASE}/token`);
  expect(json.code_challenge_methods_supported).toEqual(["S256"]);
});

test("the /mcp 401 challenge points at an RFC 9728 document that is served", async () => {
  const doFetch = fetcher(makeEnv());
  const challenge = await doFetch(new Request(`${BASE}/mcp`, { method: "POST" }));
  expect(challenge.status).toBe(401);
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge.headers.get("WWW-Authenticate") ?? "")?.[1];
  expect(metadataUrl).toBe(`${BASE}/.well-known/oauth-protected-resource/mcp`);

  const res = await doFetch(new Request(metadataUrl!));
  expect(res.status).toBe(200);
  const json = (await res.json()) as Record<string, unknown>;
  expect(json.resource).toBe(`${BASE}/mcp`);
  expect(json.authorization_servers).toEqual([BASE]);
  expect(json.scopes_supported).toEqual(["dovecote:notify", "dovecote:admin"]);
});

test("GET /authorize with code_challenge_method=plain is 400", async () => {
  const doFetch = fetcher(makeEnv());
  const redirectUri = "https://claude.ai/api/mcp/auth_callback";
  const clientId = await bootstrapClient(doFetch, [redirectUri]);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state: "s",
    code_challenge: generateCodeVerifier(),
    code_challenge_method: "plain",
  });
  const res = await doFetch(new Request(`${BASE}/authorize?${params}`));
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
});

test("the CLI's loopback client signs in on an ephemeral 127.0.0.1 port", async () => {
  const env = makeEnv();
  const doFetch = fetcher(env);
  // Same registration as the production dovecote-cli-loopback client.
  const clientId = await bootstrapClient(doFetch, ["http://127.0.0.1"]);
  const { accessToken } = await runFormOAuthFlow({
    doFetch,
    env,
    clientId,
    redirectUri: "http://127.0.0.1:53017",
    scope: "dovecote:notify",
    state: "s",
    baseUrl: BASE,
  });
  expect(accessToken).toBeTruthy();
});

test("POST /v1/auth/exchange trades a real OAuth access token for a dvct_ token", async () => {
  const env = makeEnv();
  const doFetch = fetcher(env);
  const clientId = await bootstrapClient(doFetch, ["http://127.0.0.1"]);
  const { accessToken } = await runFormOAuthFlow({
    doFetch,
    env,
    clientId,
    redirectUri: "http://127.0.0.1:53017",
    scope: "dovecote:admin",
    state: "s",
    tokenScopes: ["dovecote:admin", "dovecote:notify"],
    baseUrl: BASE,
  });

  const res = await doFetch(
    new Request(`${BASE}/v1/auth/exchange`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: "{}",
    }),
  );
  expect(res.status).toBe(201);
  expect(((await res.json()) as { token: string }).token).toMatch(/^dvct_/);
});

test("POST /token refuses a code redeemed without its S256 verifier", async () => {
  const env = makeEnv();
  const doFetch = fetcher(env);
  const redirectUri = "https://claude.ai/api/mcp/auth_callback";
  const clientId = await bootstrapClient(doFetch, [redirectUri]);
  const verifier = generateCodeVerifier();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state: "s",
    code_challenge: await generateCodeChallenge(verifier),
    code_challenge_method: "S256",
  });
  const minted = await issueToken({ userId: "alice", scopes: ["dovecote:notify"] }, env);
  params.set("token", minted.token);
  const authorized = await doFetch(
    new Request(`${BASE}/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    }),
  );
  expect(authorized.status).toBe(302);
  const code = new URL(authorized.headers.get("Location")!).searchParams.get("code")!;

  const res = await doFetch(
    new Request(`${BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
      }).toString(),
    }),
  );
  expect(res.status).toBe(400);
  expect(((await res.json()) as { access_token?: string }).access_token).toBeUndefined();
});
