/**
 * OIDC id_token verify primitive (C-OidcVerify).
 *
 * - Decodes the id_token header/payload as JSON without verifying — purely to
 *   pluck the `iss` claim and reject before any JWKS fetch when the issuer
 *   isn't allow-listed.
 * - Once the issuer is allow-listed, delegates to `jose.jwtVerify(token, jwks,
 *   {issuer, audience, clockTolerance})` and maps jose's typed errors into
 *   our typed in-band outcome.
 * - Network/JWKS failures collapse into `bad_signature` from the caller's
 *   perspective (caller logs the underlying error separately).
 */

import * as jose from "jose";
import type { OidcIssuerConfig } from "./oidc-config.js";

/**
 * JWKS-resolver injection point: given an allow-listed issuer config, return
 * a `JWTVerifyGetKey` (jose's resolver signature) usable by `jwtVerify`.
 * The endpoint hands in a module-cached factory; tests hand in a per-call
 * stub backed by an in-memory `JWK` so no live HTTP is needed.
 */
export type JwksResolver = (
  issuer: OidcIssuerConfig,
) => jose.JWTVerifyGetKey | Promise<jose.JWTVerifyGetKey>;

export type OidcVerifyOutcome =
  | {
      kind: "ok";
      issuer: string;
      subClaim: string;
      claims: Record<string, unknown>;
    }
  | { kind: "untrusted_issuer" }
  | { kind: "bad_signature" }
  | { kind: "bad_audience" }
  | { kind: "expired_token" }
  | { kind: "iat_skew" }
  | { kind: "malformed_token" };

export interface VerifyOidcIdTokenInput {
  idToken: string;
  allowList: OidcIssuerConfig[];
  clockToleranceSec: number;
  jwksResolver: JwksResolver;
  /** Optional override for `now` (ms since epoch); used by tests. */
  nowMs?: number;
}

/**
 * Decode the JWT payload (no signature check) so we can read `iss`.
 * Returns null if the token isn't a well-formed `header.payload.signature`
 * 3-part JWT or the payload isn't a JSON object.
 */
function decodeIssuerClaim(idToken: string): string | null {
  if (typeof idToken !== "string") return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    // base64url → base64
    const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = atob(padded);
    const obj = JSON.parse(json);
    if (obj && typeof obj === "object" && typeof obj.iss === "string") {
      return obj.iss as string;
    }
    return null;
  } catch {
    return null;
  }
}

export async function verifyOidcIdToken(
  input: VerifyOidcIdTokenInput,
): Promise<OidcVerifyOutcome> {
  const iss = decodeIssuerClaim(input.idToken);
  if (iss === null) {
    return { kind: "malformed_token" };
  }
  const issuerConfig = input.allowList.find((cfg) => cfg.issuer === iss);
  if (!issuerConfig) {
    // Issuer allow-list filter runs BEFORE any JWKS lookup.
    return { kind: "untrusted_issuer" };
  }

  let getKey: jose.JWTVerifyGetKey;
  try {
    getKey = await input.jwksResolver(issuerConfig);
  } catch {
    // Treat JWKS resolution failure indistinguishably from a bad signature
    // (the caller cannot trust the token either way). Endpoint handler logs
    // the underlying error separately.
    return { kind: "bad_signature" };
  }

  const verifyOptions: jose.JWTVerifyOptions = {
    issuer: issuerConfig.issuer,
    audience: issuerConfig.audience,
    clockTolerance: input.clockToleranceSec,
    algorithms: ["RS256"],
  };
  if (typeof input.nowMs === "number") {
    verifyOptions.currentDate = new Date(input.nowMs);
  }

  let result: jose.JWTVerifyResult;
  try {
    result = await jose.jwtVerify(input.idToken, getKey, verifyOptions);
  } catch (e) {
    return mapJoseError(e, input.clockToleranceSec, input.nowMs);
  }

  const claims = result.payload as Record<string, unknown>;

  // Belt-and-suspenders iat-skew check: jose's `jwtVerify` validates `exp`
  // and `nbf` against the clock-tolerance window but does NOT reject a token
  // whose `iat` is far in the future. We enforce that ourselves so a forged
  // future-iat token (which would otherwise survive a stale-token replay
  // window) is rejected as `iat_skew`.
  if (typeof claims.iat === "number") {
    const now = (input.nowMs ?? Date.now()) / 1000;
    if (claims.iat - now > input.clockToleranceSec) {
      return { kind: "iat_skew" };
    }
  }
  const subClaimName = issuerConfig.subClaim ?? "sub";
  const subjectVal = claims[subClaimName];
  if (typeof subjectVal !== "string" || subjectVal.length === 0) {
    return { kind: "malformed_token" };
  }
  return {
    kind: "ok",
    issuer: issuerConfig.issuer,
    subClaim: subjectVal,
    claims,
  };
}

function mapJoseError(
  e: unknown,
  clockToleranceSec: number,
  nowMs: number | undefined,
): OidcVerifyOutcome {
  if (e instanceof jose.errors.JWTExpired) {
    return { kind: "expired_token" };
  }
  if (e instanceof jose.errors.JWTClaimValidationFailed) {
    // jose surfaces the failing claim on the error instance.
    const claim = (e as jose.errors.JWTClaimValidationFailed).claim;
    if (claim === "aud") return { kind: "bad_audience" };
    if (claim === "iat" || claim === "exp" || claim === "nbf") {
      // exp here means the post-tolerance exp check we already trigger above
      // landed on a value that's actually outside our window — but the more
      // common "iat in the future" path lands in `iat` claim. Either way the
      // intent is to surface the iat-skew slug for tests.
      if (claim === "iat") return { kind: "iat_skew" };
      if (claim === "nbf") return { kind: "iat_skew" };
      return { kind: "expired_token" };
    }
    return { kind: "malformed_token" };
  }
  if (e instanceof jose.errors.JWSSignatureVerificationFailed) {
    return { kind: "bad_signature" };
  }
  if (
    e instanceof jose.errors.JWKSNoMatchingKey ||
    e instanceof jose.errors.JWKSMultipleMatchingKeys ||
    e instanceof jose.errors.JWKSInvalid ||
    e instanceof jose.errors.JWKSTimeout ||
    e instanceof jose.errors.JWKInvalid
  ) {
    return { kind: "bad_signature" };
  }
  if (e instanceof jose.errors.JOSEAlgNotAllowed) {
    return { kind: "bad_signature" };
  }
  if (
    e instanceof jose.errors.JWTInvalid ||
    e instanceof jose.errors.JWSInvalid ||
    e instanceof jose.errors.JOSENotSupported
  ) {
    return { kind: "malformed_token" };
  }
  // Unknown jose error → treat as malformed (fail-closed).
  void clockToleranceSec;
  void nowMs;
  return { kind: "malformed_token" };
}
