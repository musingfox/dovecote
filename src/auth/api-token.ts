import type { AuthCtx, AuthMethod } from "./ctx";
import { SCOPES_SUPPORTED, type ScopeSupported } from "./scopes";
import type { Env } from "../types";

/**
 * Token prefix as per D1
 */
export const TOKEN_PREFIX = "dvct_";

/**
 * Token ID length in bytes (8 bytes → base64url ~11 chars)
 */
const TOKEN_ID_BYTES = 8;

/**
 * Token body length in bytes (24 random bytes → base64url ~32 chars)
 */
const TOKEN_BODY_BYTES = 24;

/**
 * Default TTL in seconds: 90 days = 7_776_000 seconds
 */
export const DEFAULT_TTL_SECONDS = 7_776_000;

/**
 * Maximum TTL in seconds: 90 days = 7_776_000 seconds
 */
export const MAX_TTL_SECONDS = 7_776_000;

/**
 * KV namespace prefix for API tokens (by tokenId)
 */
export const KV_NAMESPACE = "apitoken:";

/**
 * KV namespace prefix for token hash index (by hash)
 */
export const KV_HASH_NAMESPACE = "apitoken_hash:";

/**
 * Error: any scope is not in SCOPES_SUPPORTED
 */
export class InvalidScopeError extends Error {
  constructor(scope: string) {
    super(`Invalid scope: ${scope}`);
    this.name = "InvalidScopeError";
  }
}

/**
 * Error: HMAC_PEPPER is missing from env
 */
export class MissingPepperError extends Error {
  constructor() {
    super("HMAC_PEPPER is not configured");
    this.name = "MissingPepperError";
  }
}

/**
 * Error: KV write operation rejected
 */
export class KVWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KVWriteError";
  }
}

/**
 * Metadata stored in KV for each token
 */
export interface TokenMetadata {
  tokenId: string;
  userId: string;
  scopes: string[];
  hash: string;
  createdAt: number;
  expiresAt: number;
  label?: string;
}

/**
 * Result of issueToken
 */
export interface IssueResult {
  token: string;
  tokenId: string;
  expiresAt: number;
}

/**
 * Verify result: AuthCtx or null (not found/invalid/expired)
 * @deprecated Use VerifyOutcome instead.
 */
export type VerifyResult = AuthCtx | null;

/**
 * Discriminated outcome from verifyToken.
 * - `valid`: token found, hash matches, not expired; AuthCtx attached
 * - `expired`: token found in KV but expiresAt <= now; tokenId/userId/scopes surfaced for audit
 * - `invalid`: bad prefix or not present in KV (no metadata available)
 */
export type VerifyOutcome =
  | { kind: "valid"; auth: AuthCtx }
  | { kind: "expired"; tokenId: string; userId: string; scopes: string[] }
  | { kind: "invalid" };

/**
 * Result of revokeToken
 */
export interface RevokeResult {
  revoked: boolean;
}

/**
 * Timing-safe string comparison for constant-time hash verification.
 * Prevents timing attacks on hash comparison.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) {
    r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return r === 0;
}

/**
 * Generate a URL-safe base64-encoded random string.
 */
function generateRandomBase64Url(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/**
 * Convert Uint8Array to base64url-encoded string.
 */
function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Compute HMAC-SHA256 hash using Web Crypto API.
 * Returns hex-encoded hash string.
 */
async function computeHmacSha256(pepper: string, data: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(pepper);
  const dataData = encoder.encode(data);

  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, dataData);
  const signatureBytes = new Uint8Array(signature);
  let hex = "";
  for (let i = 0; i < signatureBytes.length; i++) {
    const byte = signatureBytes[i]!.toString(16);
    hex += byte.length === 1 ? "0" + byte : byte;
  }
  return hex;
}

/**
 * Issue a new API token.
 * 
 * @param params - Issue parameters
 * @param params.userId - User ID to bind the token to
 * @param params.scopes - List of scopes to grant
 * @param params.label - Optional label for the token
 * @param params.ttlSeconds - Optional TTL in seconds (default: 7_776_000, max: 7_776_000)
 * @param params.env - Environment with OAUTH_KV and HMAC_PEPPER
 * @param params.now - Current timestamp in milliseconds (default: Date.now())
 * @returns IssueResult with token, tokenId, and expiresAt
 * @throws InvalidScopeError - if any scope is not in SCOPES_SUPPORTED
 * @throws MissingPepperError - if HMAC_PEPPER is not set in env
 * @throws KVWriteError - if KV put operation fails
 */
export async function issueToken(
  params: {
    userId: string;
    scopes: string[];
    label?: string;
    ttlSeconds?: number;
  },
  env: Env,
  now: number = Date.now()
): Promise<IssueResult> {
  // Validate scopes
  for (const scope of params.scopes) {
    if (!SCOPES_SUPPORTED.includes(scope as ScopeSupported)) {
      throw new InvalidScopeError(scope);
    }
  }

  // Check for HMAC_PEPPER
  if (!env.HMAC_PEPPER) {
    throw new MissingPepperError();
  }

  // Generate tokenId (8 bytes → ~11 base64url chars)
  const tokenId = generateRandomBase64Url(TOKEN_ID_BYTES);

  // Generate token body (24 bytes → ~32 base64url chars)
  const tokenBody = generateRandomBase64Url(TOKEN_BODY_BYTES);

  // Full token: dvct_ + body
  const token = TOKEN_PREFIX + tokenBody;

  // Compute hash: HMAC-SHA256(HMAC_PEPPER, fullToken)
  const hash = await computeHmacSha256(env.HMAC_PEPPER, token);

  // Calculate expiresAt in MILLISECONDS (per D7: now + 7776000000)
  const ttlSeconds = Math.min(params.ttlSeconds ?? DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS);
  const expiresAt = now + ttlSeconds * 1000;

  // Build metadata
  const metadata: TokenMetadata = {
    tokenId,
    userId: params.userId,
    scopes: params.scopes,
    hash,
    createdAt: now,
    expiresAt,
    label: params.label,
  };

  // Persist to KV under TWO keys:
  // 1. apitoken:<tokenId> - for issue/revoke operations (by tokenId)
  // 2. apitoken_hash:<hash> - for verify operations (by hash, for O(1) lookup)
  const kvKeyTokenId = KV_NAMESPACE + tokenId;
  const kvKeyHash = KV_HASH_NAMESPACE + hash;

  try {
    await env.OAUTH_KV.put(kvKeyTokenId, JSON.stringify(metadata), {
      expirationTtl: ttlSeconds,
    });
    await env.OAUTH_KV.put(kvKeyHash, JSON.stringify(metadata), {
      expirationTtl: ttlSeconds,
    });
  } catch (e) {
    throw new KVWriteError(`Failed to persist token to KV: ${(e as Error).message}`);
  }

  return {
    token,
    tokenId,
    expiresAt,
  };
}

/**
 * Verify a presented bearer token.
 *
 * Returns a discriminated VerifyOutcome so callers (middleware) can map
 * "invalid" vs "expired" to distinct OAuth 2.0 error_description slugs.
 *
 * No KV writes are performed on expiry — lazy cleanup is out of scope.
 *
 * @param token - The raw bearer token string (e.g. "dvct_…")
 * @param env - Environment with OAUTH_KV and HMAC_PEPPER
 * @param now - Current timestamp in milliseconds (default: Date.now())
 * @returns VerifyOutcome ({kind:"valid"|"expired"|"invalid"})
 * @throws KVWriteError - if KV read operation fails (infrastructure error)
 */
export async function verifyToken(
  token: string,
  env: Env,
  now: number = Date.now()
): Promise<VerifyOutcome> {
  // Check prefix — no KV read on malformed tokens
  if (!token.startsWith(TOKEN_PREFIX)) {
    return { kind: "invalid" };
  }

  // Compute hash of presented token
  const tokenHash = await computeHmacSha256(env.HMAC_PEPPER, token);

  // Look up by hash for O(1) verification
  const kvKeyHash = KV_HASH_NAMESPACE + tokenHash;
  let metadataStr: any;
  try {
    metadataStr = await env.OAUTH_KV.get(kvKeyHash, "json");
  } catch (e) {
    throw new KVWriteError(`Failed to read token from KV: ${(e as Error).message}`);
  }

  if (!metadataStr) {
    // Token not found or hash doesn't match any token
    return { kind: "invalid" };
  }

  const metadata = metadataStr as TokenMetadata;

  // Check expiration (expiresAt is in MILLISECONDS, per D7)
  // expiresAt === now is treated as expired (off-by-one safety)
  if (metadata.expiresAt <= now) {
    return {
      kind: "expired",
      tokenId: metadata.tokenId,
      userId: metadata.userId,
      scopes: metadata.scopes,
    };
  }

  // Valid token found
  return {
    kind: "valid",
    auth: {
      userId: metadata.userId,
      scopes: metadata.scopes,
      tokenId: metadata.tokenId,
      authMethod: "api_token" as AuthMethod,
      ip: "unknown", // Per C2.2.b spec; middleware enriches in PR-C
    },
  };
}

/**
 * Revoke a token by tokenId.
 * 
 * @param params - Revocation parameters
 * @param params.tokenId - The tokenId to revoke
 * @param params.env - Environment with OAUTH_KV
 * @returns RevokeResult with revoked boolean
 * @throws KVWriteError - if KV delete operation fails
 */
export async function revokeToken(
  params: { tokenId: string; env: Env },
  env: Env
): Promise<RevokeResult> {
  const kvKeyTokenId = KV_NAMESPACE + params.tokenId;
  const kvKeyHash = KV_HASH_NAMESPACE; // We need the hash to delete this

  // First, get the token metadata to find the hash
  const metadataStr = await env.OAUTH_KV.get(kvKeyTokenId, "json");

  if (!metadataStr) {
    // Token not found, nothing to revoke
    return { revoked: false };
  }

  const metadata = metadataStr as TokenMetadata;
  const kvKeyHashValue = KV_HASH_NAMESPACE + metadata.hash;

  // Delete both keys
  try {
    await env.OAUTH_KV.delete(kvKeyTokenId);
    await env.OAUTH_KV.delete(kvKeyHashValue);
  } catch (e) {
    throw new KVWriteError(`Failed to delete token from KV: ${(e as Error).message}`);
  }

  return {
    revoked: true,
  };
}
