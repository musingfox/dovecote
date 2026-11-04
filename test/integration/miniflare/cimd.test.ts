/**
 * The claude.ai Client ID Metadata Document signs in on the wrangler-built
 * bundle inside workerd, where the provider reads global_fetch_strictly_public
 * from the real compatibility flags. The document fetch goes to a stub.
 */

import { beforeAll, afterAll, test, expect } from "bun:test";
import { initMiniflare, disposeMiniflare, getMiniflare, seedDvctToken } from "./setup.js";
import { generateCodeVerifier, generateCodeChallenge } from "../../helpers/pkce.js";

const CLIENT_ID = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const fetched: string[] = [];

beforeAll(async () => {
  await initMiniflare(undefined, (request) => {
    fetched.push(request.url);
    if (request.url !== CLIENT_ID) return new Response("not found", { status: 404 });
    return Response.json({
      client_id: CLIENT_ID,
      client_name: "Claude",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });
}, 30_000);

afterAll(async () => {
  await disposeMiniflare();
});

test("authorization server metadata advertises client metadata documents", async () => {
  const res = await getMiniflare().dispatchFetch("https://example.com/.well-known/oauth-authorization-server");
  const json = (await res.json()) as Record<string, unknown>;
  expect(json.client_id_metadata_document_supported).toBe(true);
});

test("the claude.ai document signs in without a bootstrapped client", async () => {
  const mf = getMiniflare();
  const { token } = await seedDvctToken({ userId: "cimd-user", scopes: ["dovecote:notify"] });
  const codeVerifier = generateCodeVerifier();
  const oauthParams = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    state: "s",
    code_challenge: await generateCodeChallenge(codeVerifier),
    code_challenge_method: "S256",
  });

  const formRes = await mf.dispatchFetch(`https://example.com/authorize?${oauthParams}`, { redirect: "manual" });
  expect(formRes.status).toBe(200);
  await formRes.text();

  const postBody = new URLSearchParams(oauthParams);
  postBody.set("token", token);
  const postRes = await mf.dispatchFetch("https://example.com/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: postBody.toString(),
    redirect: "manual",
  });
  expect(postRes.status).toBe(302);
  const code = new URL(postRes.headers.get("location") ?? "").searchParams.get("code");
  expect(code).toBeTruthy();

  const tokenRes = await mf.dispatchFetch("https://example.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
    }).toString(),
  });
  expect(tokenRes.status).toBe(200);
  expect(((await tokenRes.json()) as { access_token: string }).access_token).toBeTruthy();
  expect(fetched.length).toBeGreaterThan(0);
  expect(fetched.every((url) => url === CLIENT_ID)).toBe(true);
});

test("a URL client_id outside the allowlist is refused without a fetch", async () => {
  const before = fetched.length;
  const params = new URLSearchParams({
    client_id: "https://evil.example/client.json",
    redirect_uri: "https://evil.example/cb",
    response_type: "code",
    code_challenge: await generateCodeChallenge(generateCodeVerifier()),
    code_challenge_method: "S256",
  });
  const res = await getMiniflare().dispatchFetch(`https://example.com/authorize?${params}`, { redirect: "manual" });
  expect(res.status).toBe(400);
  expect(res.headers.get("location")).toBeNull();
  expect(((await res.json()) as { error: string }).error).toBe("invalid_client");
  expect(fetched.length).toBe(before);
});
