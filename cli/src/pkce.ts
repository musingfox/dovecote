/**
 * PKCE (RFC 7636) helpers. Pure WebCrypto — no Bun.* API.
 */

export function generateCodeVerifier(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(verifier));
  return base64UrlEncode(new Uint8Array(hash));
}

export function base64UrlEncode(buffer: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < buffer.length; i++) {
    bin += String.fromCharCode(buffer[i]!);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * RFC 7636 + dovecote loopback contract: only IPv4 127.0.0.1 or IPv6 [::1]
 * with an explicit port. Used to validate the redirect_uri the CLI hands the
 * OAuth provider.
 */
export const LOOPBACK_REGEX = /^http:\/\/(127\.0\.0\.1|\[::1\]):\d+$/;

export function isLoopbackRedirect(url: string): boolean {
  return LOOPBACK_REGEX.test(url);
}
