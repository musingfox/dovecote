import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/** A test double that implements only the helpers the code under test calls. */
export function stubOAuthHelpers(stub: Partial<OAuthHelpers>): OAuthHelpers {
  return stub as OAuthHelpers;
}
