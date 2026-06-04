/**
 * OIDC RP signed-state codec.
 *
 * Encodes the inbound AuthRequest fields (plus RP nonce) into a compact
 * HMAC-signed token that survives the round-trip through the upstream IdP
 * as the OAuth `state` parameter.  Tampered / bad-signature / malformed
 * tokens decode to null — never throw.
 *
 * Format: base64url(JSON(payload)) "." base64url(HMAC-SHA256(key, body))
 */

import type { AuthRequest } from "@cloudflare/workers-oauth-provider";

export type OidcStatePayload = {
  clientId: string;
  redirectUri: string;
  scope: string[];
  state: string;
  nonce: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  responseType: string;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(b64u: string): Uint8Array {
  const b64 = b64u.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  const keyData = new TextEncoder().encode(secret);
  return crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign", "verify"],
  );
}

async function hmacSign(key: CryptoKey, data: string): Promise<Uint8Array> {
  const dataBytes = new TextEncoder().encode(data);
  const sig = await crypto.subtle.sign("HMAC", key, dataBytes);
  return new Uint8Array(sig);
}

/**
 * Constant-time comparison of two Uint8Array values.
 * Returns false if lengths differ (leaks length but not content).
 */
function safeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) {
    r |= a[i]! ^ b[i]!;
  }
  return r === 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encode an OidcStatePayload into a signed state token.
 * Returns a string of the form `<body>.<sig>` where both parts are base64url.
 */
export async function encodeOidcState(
  payload: OidcStatePayload,
  secret: string,
): Promise<string> {
  const bodyJson = JSON.stringify(payload);
  const bodyB64 = toBase64Url(new TextEncoder().encode(bodyJson));
  const key = await importHmacKey(secret);
  const sigBytes = await hmacSign(key, bodyB64);
  const sigB64 = toBase64Url(sigBytes);
  return `${bodyB64}.${sigB64}`;
}

/**
 * Decode and verify a signed state token.
 * Returns null on any error (tampered, wrong secret, malformed).  Never throws.
 */
export async function decodeOidcState(
  token: string,
  secret: string,
): Promise<OidcStatePayload | null> {
  try {
    if (typeof token !== "string" || token.length === 0) return null;
    const dot = token.lastIndexOf(".");
    if (dot <= 0) return null;

    const bodyB64 = token.slice(0, dot);
    const sigB64 = token.slice(dot + 1);

    // Recompute expected signature
    const key = await importHmacKey(secret);
    const expectedBytes = await hmacSign(key, bodyB64);

    // Decode provided signature
    let providedBytes: Uint8Array;
    try {
      providedBytes = fromBase64Url(sigB64);
    } catch {
      return null;
    }

    // Constant-time compare
    if (!safeEqualBytes(expectedBytes, providedBytes)) return null;

    // Decode body
    let bodyBytes: Uint8Array;
    try {
      bodyBytes = fromBase64Url(bodyB64);
    } catch {
      return null;
    }

    const bodyJson = new TextDecoder().decode(bodyBytes);
    const parsed: unknown = JSON.parse(bodyJson);

    // Basic shape validation
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    if (
      typeof obj.clientId !== "string" ||
      typeof obj.redirectUri !== "string" ||
      !Array.isArray(obj.scope) ||
      typeof obj.state !== "string" ||
      typeof obj.nonce !== "string" ||
      typeof obj.responseType !== "string"
    ) {
      return null;
    }

    return {
      clientId: obj.clientId,
      redirectUri: obj.redirectUri,
      scope: obj.scope as string[],
      state: obj.state,
      nonce: obj.nonce,
      responseType: obj.responseType,
      ...(typeof obj.codeChallenge === "string"
        ? { codeChallenge: obj.codeChallenge }
        : {}),
      ...(typeof obj.codeChallengeMethod === "string"
        ? { codeChallengeMethod: obj.codeChallengeMethod }
        : {}),
    };
  } catch {
    return null;
  }
}
