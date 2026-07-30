/**
 * Shared helper: drive the M1 token-paste OAuth flow end-to-end against an
 * in-process app (or any doFetch transport).
 *
 *   issueToken (dvct_*) → GET /authorize (200 form) → POST /authorize with the
 *   pasted token (302 + code) → POST /token (PKCE) → access_token
 */

import { issueToken } from "../../src/auth/api-token.js";
import { generateCodeVerifier, generateCodeChallenge } from "./pkce.js";
import type { Env } from "../../src/types.js";

export interface FormFlowOpts {
  /** Transport to the app under test (in-process app.fetch or HTTP). */
  doFetch: (req: Request) => Promise<Response>;
  /** Env sharing OAUTH_KV + HMAC_PEPPER with the app under test. */
  env: Env;
  clientId: string;
  redirectUri: string;
  /** Requested OAuth scope (informational — grant scope = token scopes, M5). */
  scope: string;
  state: string;
  userId?: string;
  /** Scopes minted onto the dvct token (drives the final grant scopes). */
  tokenScopes?: string[];
  baseUrl?: string;
}

export interface FormFlowResult {
  accessToken: string;
  refreshToken?: string;
  dvctToken: string;
}

export async function runFormOAuthFlow(opts: FormFlowOpts): Promise<FormFlowResult> {
  const {
    doFetch,
    env,
    clientId,
    redirectUri,
    scope,
    state,
    userId = "e2e-user",
    tokenScopes = ["dovecote:notify"],
    baseUrl = "http://localhost",
  } = opts;

  // 1. Mint the root credential locally (same KV/pepper as the app).
  const minted = await issueToken({ userId, scopes: tokenScopes }, env);

  // 2. PKCE
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const oauthParams = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    scope,
  });

  // 3. GET /authorize → 200 token-paste form
  const formRes = await doFetch(new Request(`${baseUrl}/authorize?${oauthParams}`));
  if (formRes.status !== 200) {
    throw new Error(`GET /authorize returned ${formRes.status}: ${await formRes.text()}`);
  }
  const formHtml = await formRes.text();
  if (!formHtml.includes('name="token"')) {
    throw new Error("authorize form is missing the token field");
  }
  if (!formHtml.includes('name="code_challenge"')) {
    throw new Error("authorize form dropped the PKCE code_challenge hidden field");
  }

  // 4. POST /authorize with the pasted token + the same OAuth params → 302 + code
  const postBody = new URLSearchParams(oauthParams);
  postBody.set("token", minted.token);
  const postRes = await doFetch(
    new Request(`${baseUrl}/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: postBody.toString(),
    }),
  );
  if (postRes.status !== 302) {
    throw new Error(`POST /authorize returned ${postRes.status}: ${await postRes.text()}`);
  }
  const location = postRes.headers.get("Location") ?? "";
  const code = new URL(location).searchParams.get("code");
  if (!code) {
    throw new Error(`no authorization code in redirect: ${location}`);
  }

  // 5. POST /token (authorization_code + PKCE verifier)
  const tokenForm = new URLSearchParams();
  tokenForm.set("grant_type", "authorization_code");
  tokenForm.set("code", code);
  tokenForm.set("redirect_uri", redirectUri);
  tokenForm.set("client_id", clientId);
  tokenForm.set("code_verifier", codeVerifier);

  const tokenRes = await doFetch(
    new Request(`${baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenForm.toString(),
    }),
  );
  if (tokenRes.status !== 200) {
    throw new Error(`token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const tokenData = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
  };
  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    dvctToken: minted.token,
  };
}
