import { GrantType, OAuthError } from "@cloudflare/workers-oauth-provider";
import type { TokenExchangeCallbackOptions } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../types.js";
import { getLiveBoundToken } from "./api-token.js";

/**
 * The provider's tokenExchangeCallback: a refresh succeeds only while the dvct
 * token the grant is bound to is live. invalid_grant makes the provider revoke
 * the grant and tells the MCP client to re-authorize, rather than handing it
 * an access token that /mcp then refuses.
 */
export async function refuseRefreshOfUnboundGrant(
  options: TokenExchangeCallbackOptions<Env>,
): Promise<void> {
  if (options.grantType !== GrantType.REFRESH_TOKEN) return;
  const bound = await getLiveBoundToken(options.props?.tokenId, options.userId, options.env);
  if (!bound) {
    throw new OAuthError("invalid_grant", { description: "API token revoked or expired" });
  }
}
