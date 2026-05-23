import { test, expect, beforeAll } from "bun:test";
import * as jose from "jose";
import {
  verifyOidcIdToken,
  type JwksResolver,
} from "../../src/auth/oidc-verify.js";
import type { OidcIssuerConfig } from "../../src/auth/oidc-config.js";

const ISSUER = "https://issuer.example";
const AUDIENCE = "aud-1";
const KID = "test-kid";

const allowList: OidcIssuerConfig[] = [
  { issuer: ISSUER, jwks_uri: `${ISSUER}/jwks`, audience: AUDIENCE },
];

let trustedKeyPair: jose.GenerateKeyPairResult;
let attackerKeyPair: jose.GenerateKeyPairResult;
let resolver: JwksResolver;

beforeAll(async () => {
  trustedKeyPair = await jose.generateKeyPair("RS256", { extractable: true });
  attackerKeyPair = await jose.generateKeyPair("RS256", { extractable: true });
  // Local-only resolver — backs the allow-listed issuer with the trusted
  // public key (as a JWK set). No live HTTP.
  resolver = (cfg) => {
    if (cfg.issuer !== ISSUER) {
      throw new Error(`unexpected issuer in test resolver: ${cfg.issuer}`);
    }
    return async () => trustedKeyPair.publicKey;
  };
});

async function signIdToken(
  payload: Record<string, unknown>,
  opts: {
    privateKey?: CryptoKey;
    iat?: number;
    exp?: number;
  } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const iat = opts.iat ?? now - 60;
  const exp = opts.exp ?? now + 3600;
  return new jose.SignJWT({ ...payload })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer((payload.iss as string) ?? ISSUER)
    .setAudience((payload.aud as string) ?? AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setSubject((payload.sub as string) ?? "user_a")
    .sign(opts.privateKey ?? trustedKeyPair.privateKey);
}

test("C-OidcVerify: ok — valid id_token signed by allow-listed issuer", async () => {
  const idToken = await signIdToken({ sub: "user_a" });
  const out = await verifyOidcIdToken({
    idToken,
    allowList,
    clockToleranceSec: 60,
    jwksResolver: resolver,
  });
  expect(out.kind).toBe("ok");
  if (out.kind === "ok") {
    expect(out.issuer).toBe(ISSUER);
    expect(out.subClaim).toBe("user_a");
    expect(out.claims.sub).toBe("user_a");
  }
});

test("C-OidcVerify: untrusted_issuer when iss is not in allowList (no JWKS lookup)", async () => {
  let resolverCalls = 0;
  const guardedResolver: JwksResolver = (cfg) => {
    resolverCalls += 1;
    return resolver(cfg);
  };
  // sign with a different iss
  const idToken = await signIdToken({
    iss: "https://other.example",
    sub: "user_a",
  });
  const out = await verifyOidcIdToken({
    idToken,
    allowList,
    clockToleranceSec: 60,
    jwksResolver: guardedResolver,
  });
  expect(out.kind).toBe("untrusted_issuer");
  // Verify ordering: resolver was never consulted.
  expect(resolverCalls).toBe(0);
});

test("C-OidcVerify: bad_audience when aud claim doesn't match config", async () => {
  const idToken = await signIdToken({ sub: "user_a", aud: "wrong" });
  const out = await verifyOidcIdToken({
    idToken,
    allowList,
    clockToleranceSec: 60,
    jwksResolver: resolver,
  });
  expect(out.kind).toBe("bad_audience");
});

test("C-OidcVerify: expired_token when exp is 10min past", async () => {
  const now = Math.floor(Date.now() / 1000);
  const idToken = await signIdToken({ sub: "user_a" }, {
    iat: now - 700,
    exp: now - 600, // 10min ago
  });
  const out = await verifyOidcIdToken({
    idToken,
    allowList,
    clockToleranceSec: 60,
    jwksResolver: resolver,
  });
  expect(out.kind).toBe("expired_token");
});

test("C-OidcVerify: iat_skew when iat is 600s in the future, tolerance 60", async () => {
  const now = Math.floor(Date.now() / 1000);
  const idToken = await signIdToken({ sub: "user_a" }, {
    iat: now + 600,
    exp: now + 3600,
  });
  const out = await verifyOidcIdToken({
    idToken,
    allowList,
    clockToleranceSec: 60,
    jwksResolver: resolver,
  });
  expect(out.kind).toBe("iat_skew");
});

test("C-OidcVerify: bad_signature when signed by a different key", async () => {
  const idToken = await signIdToken(
    { sub: "user_a" },
    { privateKey: attackerKeyPair.privateKey },
  );
  const out = await verifyOidcIdToken({
    idToken,
    allowList,
    clockToleranceSec: 60,
    jwksResolver: resolver,
  });
  expect(out.kind).toBe("bad_signature");
});

test("C-OidcVerify: malformed_token for \"not.a.jwt\"", async () => {
  // Must use 3 parts but with non-base64 payload to ensure we hit decode/verify
  // path producing malformed_token. A 3-segment but unparseable token yields
  // malformed via the pre-decode step.
  const out = await verifyOidcIdToken({
    idToken: "not.a.jwt",
    allowList,
    clockToleranceSec: 60,
    jwksResolver: resolver,
  });
  expect(out.kind).toBe("malformed_token");
});

test("C-OidcVerify: malformed_token for non-JWT-shaped string", async () => {
  const out = await verifyOidcIdToken({
    idToken: "garbage",
    allowList,
    clockToleranceSec: 60,
    jwksResolver: resolver,
  });
  expect(out.kind).toBe("malformed_token");
});

test("C-OidcVerify: JWKS resolver failure collapses to bad_signature", async () => {
  const idToken = await signIdToken({ sub: "user_a" });
  const failingResolver: JwksResolver = () => {
    throw new Error("network down");
  };
  const out = await verifyOidcIdToken({
    idToken,
    allowList,
    clockToleranceSec: 60,
    jwksResolver: failingResolver,
  });
  expect(out.kind).toBe("bad_signature");
});

test("C-OidcVerify: uses configured subClaim when set (e.g. \"email\")", async () => {
  const customAllow: OidcIssuerConfig[] = [
    {
      issuer: ISSUER,
      jwks_uri: `${ISSUER}/jwks`,
      audience: AUDIENCE,
      subClaim: "email",
    },
  ];
  const now = Math.floor(Date.now() / 1000);
  const idToken = await new jose.SignJWT({
    sub: "internal-id",
    email: "user@example",
  })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 3600)
    .sign(trustedKeyPair.privateKey);
  const out = await verifyOidcIdToken({
    idToken,
    allowList: customAllow,
    clockToleranceSec: 60,
    jwksResolver: resolver,
  });
  expect(out.kind).toBe("ok");
  if (out.kind === "ok") {
    expect(out.subClaim).toBe("user@example");
  }
});
