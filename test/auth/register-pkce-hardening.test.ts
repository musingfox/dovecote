import { test, expect } from "bun:test";
import app from "../../src/index.js";
import type { Env } from "../../src/types.js";
import { MockKV } from "../helpers/mock-kv.js";
import { createMockExecutionCtx } from "../helpers/mock-execution-ctx.js";
import { issueToken } from "../../src/auth/api-token.js";

const BASE = "https://example.com";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

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

test("POST /register does not exist, even for a confidential client", async () => {
  const doFetch = fetcher(makeEnv());
  const res = await doFetch(
    new Request(`${BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "attacker",
        redirect_uris: ["https://attacker.example/cb"],
        token_endpoint_auth_method: "client_secret_basic",
      }),
    }),
  );
  expect(res.status).toBe(404);
});

test("authorization server metadata no longer advertises a registration endpoint", async () => {
  const res = await fetcher(makeEnv())(new Request(`${BASE}/.well-known/oauth-authorization-server`));
  expect(((await res.json()) as Record<string, unknown>).registration_endpoint).toBeUndefined();
});

async function bootstrapClient(doFetch: (r: Request) => Promise<Response>): Promise<string> {
  const res = await doFetch(
    new Request(`${BASE}/admin/bootstrap-client`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer admin-token-123" },
      body: JSON.stringify({ clientName: "c", redirectUris: [REDIRECT_URI] }),
    }),
  );
  return ((await res.json()) as { client_id: string }).client_id;
}

function authParams(clientId: string, pkce: Record<string, string>): URLSearchParams {
  return new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    state: "s",
    scope: "dovecote:notify",
    ...pkce,
  });
}

// code_challenge_method=S256 alone passes the provider's "no plain PKCE" check
// while leaving codeChallenge undefined, which workers-oauth-provider 0.4 reads
// as "PKCE off" and then issues a token without any code_verifier.
const METHOD_WITHOUT_CHALLENGE = { code_challenge_method: "S256" };

test("GET /authorize with code_challenge_method but no code_challenge is 400", async () => {
  const doFetch = fetcher(makeEnv());
  const clientId = await bootstrapClient(doFetch);
  const res = await doFetch(new Request(`${BASE}/authorize?${authParams(clientId, METHOD_WITHOUT_CHALLENGE)}`));
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
});

test("GET /authorize with no PKCE parameters is 400, not 500", async () => {
  const doFetch = fetcher(makeEnv());
  const clientId = await bootstrapClient(doFetch);
  const res = await doFetch(new Request(`${BASE}/authorize?${authParams(clientId, {})}`));
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
});

test("POST /authorize without code_challenge issues no authorization code", async () => {
  const env = makeEnv();
  const doFetch = fetcher(env);
  const clientId = await bootstrapClient(doFetch);
  const minted = await issueToken({ userId: "alice", scopes: ["dovecote:notify"] }, env);
  const body = authParams(clientId, METHOD_WITHOUT_CHALLENGE);
  body.set("token", minted.token);
  const res = await doFetch(
    new Request(`${BASE}/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }),
  );
  expect(res.status).toBe(400);
  expect(res.headers.get("Location")).toBeNull();
});
