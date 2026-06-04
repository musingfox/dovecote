/**
 * Build the upstream IdP authorization URL for the OIDC RP flow.
 *
 * Always sets response_type=code and ensures "openid" is in the scope list.
 * All other parameters are driven by the caller-supplied input.
 */

export interface BuildUpstreamAuthorizeUrlInput {
  /** Upstream IdP authorization endpoint base URL */
  authorizationEndpoint: string;
  /** RP's client_id at the upstream IdP */
  clientId: string;
  /** dovecote's own callback URL */
  redirectUri: string;
  /** Extra scopes; "openid" is always included */
  scope?: string[];
  /** Signed-state token (from encodeOidcState) */
  state: string;
  /** RP nonce, also embedded in signed state */
  nonce: string;
}

/**
 * Build the upstream authorization URL.
 * - response_type is always "code"
 * - scope always contains "openid" (union with provided, deduplicated)
 * - All params are URL-encoded via URLSearchParams
 */
export function buildUpstreamAuthorizeUrl(
  input: BuildUpstreamAuthorizeUrlInput,
): string {
  const url = new URL(input.authorizationEndpoint);

  // Merge provided scopes with "openid", deduplicate, preserve order
  const scopeSet = new Set<string>(["openid"]);
  if (input.scope) {
    for (const s of input.scope) {
      scopeSet.add(s);
    }
  }
  const scopeStr = Array.from(scopeSet).join(" ");

  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", scopeStr);
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);

  return url.toString();
}
