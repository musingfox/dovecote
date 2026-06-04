/**
 * OIDC RP state codec — signed HMAC-SHA256 envelope for the OAuth state param.
 *
 * Encodes the RP-side auth request context into a URL-safe base64 token so
 * the GET /oidc/callback handler can reconstruct the original AuthRequest
 * without any server-side session store.
 *
 * Security:
 *  - Full-body HMAC-SHA256 (constant-time comparison) → tamper-evident.
 *  - decodeOidcState returns null (never throws) on any malformed/bad-sig input.
 *  - iat is embedded and checked by the caller (TTL 600 s).
 */

export type OidcStatePayload = {
  clientId: string;
  redirectUri: string;
  scope: string[];
  state: string;
  nonce: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  responseType: string;
  /** Unix seconds. Override for tests; defaults to Math.floor(Date.now()/1000). */
  iat?: number;
};

// ---- internal helpers -------------------------------------------------------

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(s: string): Uint8Array | null {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

async function hmacSha256(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return base64urlEncode(new Uint8Array(sig));
}

/** Constant-time comparison (length-independent). */
function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// ---- public API -------------------------------------------------------------

/**
 * Encode a state payload into a signed token.
 *
 * Token format: base64url(body) + "." + base64url(sig)
 * where body = JSON-serialised payload (with iat stamped in).
 */
export async function encodeOidcState(
  payload: OidcStatePayload,
  secret: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const body: OidcStatePayload = {
    ...payload,
    iat: payload.iat ?? now,
  };
  const bodyJson = JSON.stringify(body);
  const bodyEnc = base64urlEncode(new TextEncoder().encode(bodyJson));
  const sig = await hmacSha256(secret, bodyEnc);
  return `${bodyEnc}.${sig}`;
}

/**
 * Decode and verify a signed state token.
 *
 * Returns null on any error (malformed, bad signature, missing fields).
 * Never throws.
 */
export async function decodeOidcState(
  token: string,
  secret: string,
): Promise<(OidcStatePayload & { iat: number }) | null> {
  try {
    const dotIdx = token.lastIndexOf(".");
    if (dotIdx === -1) return null;
    const bodyEnc = token.slice(0, dotIdx);
    const sig = token.slice(dotIdx + 1);
    if (!bodyEnc || !sig) return null;

    // Recompute expected sig and compare constant-time.
    const expectedSig = await hmacSha256(secret, bodyEnc);
    if (!safeEqual(sig, expectedSig)) return null;

    // Decode body.
    const bodyBytes = base64urlDecode(bodyEnc);
    if (!bodyBytes) return null;
    const bodyJson = new TextDecoder().decode(bodyBytes);
    const parsed = JSON.parse(bodyJson) as OidcStatePayload;

    // Minimal shape check.
    if (
      typeof parsed.clientId !== "string" ||
      typeof parsed.redirectUri !== "string" ||
      !Array.isArray(parsed.scope) ||
      typeof parsed.state !== "string" ||
      typeof parsed.nonce !== "string" ||
      typeof parsed.responseType !== "string" ||
      typeof parsed.iat !== "number"
    ) {
      return null;
    }

    return parsed as OidcStatePayload & { iat: number };
  } catch {
    return null;
  }
}
