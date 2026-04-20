import type { ResolveExternalTokenInput, ResolveExternalTokenResult } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../types.js";

/**
 * Legacy bearer token shortcut for backward compatibility
 * Allows MCP_AUTH_TOKEN to be used as a bearer token
 */
export async function resolveExternalToken(
  input: ResolveExternalTokenInput
): Promise<ResolveExternalTokenResult | null> {
  const env = input.env as Env;
  const token = input.token;

  // Early return for empty token
  if (!token || token.length === 0) {
    return null;
  }

  // Early return if MCP_AUTH_TOKEN is not set
  if (!env.MCP_AUTH_TOKEN || env.MCP_AUTH_TOKEN.length === 0) {
    return null;
  }

  // Timing-safe comparison
  if (!timingSafeEqual(token, env.MCP_AUTH_TOKEN)) {
    return null;
  }

  // Return result matching library's expected shape
  // The library uses this props object to pass to API handlers via ctx.props
  return {
    props: {
      legacy: true,
      userId: "legacy-bearer",
      scopes: ["dovecote:notify"],
    },
  };
}

/**
 * Timing-safe string comparison
 * Iterates through both strings at the same length, XORing bytes
 */
function timingSafeEqual(a: string, b: string): boolean {
  // Prevent length-based timing attacks by always iterating the same number of times
  const aLen = a.length;
  const bLen = b.length;
  const maxLen = Math.max(aLen, bLen);

  let result = aLen ^ bLen; // Start with length difference

  for (let i = 0; i < maxLen; i++) {
    const aChar = i < aLen ? a.charCodeAt(i) : 0;
    const bChar = i < bLen ? b.charCodeAt(i) : 0;
    result |= aChar ^ bChar;
  }

  return result === 0;
}
