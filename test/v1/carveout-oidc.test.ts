import { test, expect } from "bun:test";
import { Hono } from "hono";
import { bearerMiddleware } from "../../src/auth/bearer.js";
import { createAuthExchangeOidcApp } from "../../src/auth-exchange-oidc.js";
import { MockKV } from "../helpers/mock-kv.js";
import type { Env } from "../../src/types.js";

// C-Carveout-Wiring: a POST to /v1/auth/exchange-oidc must reach the OIDC
// sub-app — NOT be 401'd by the /v1/* bearer middleware first.
//
// We compose the same shape as src/index.ts (sub-app mounted BEFORE
// `app.use("/v1/*", bearerMiddleware)`). The endpoint is invoked without
// any Authorization header. If the carve-out is broken, the response would
// carry `error_description:"missing_authorization"` from the bearer path.
// If the carve-out works, the request reaches the OIDC handler and surfaces
// either 400 (missing id_token body) or 503 (OIDC_ISSUERS unset).

function composeAppLikeIndex() {
  const app = new Hono<{ Bindings: Env }>();
  // No /health route or OAuth provider needed for this assertion.
  const oidcApp = createAuthExchangeOidcApp({
    // Stubs: never invoked because the body is empty → 400 invalid_request.
    issueToken: (async () => ({
      token: "dvct_x",
      tokenId: "t",
      expiresAt: 0,
    })) as any,
    checkRateLimit: (async () => ({ allowed: true, current: 1 })) as any,
  });
  app.route("/", oidcApp);
  app.use("/v1/*", bearerMiddleware);
  return app;
}

function buildEnv(opts: { oidcIssuers?: string } = {}): Env {
  return {
    OAUTH_KV: new MockKV() as any,
    OAUTH_PASSWORD: "x",
    COOKIE_ENCRYPTION_KEY: "x".repeat(32),
    HMAC_PEPPER: "pep",
    OIDC_ISSUERS: opts.oidcIssuers,
  };
}

function execCtx() {
  return {
    props: null,
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as any;
}

test("C-Carveout-Wiring: POST /v1/auth/exchange-oidc bypasses bearer middleware (empty body → 400, not 401 missing_authorization)", async () => {
  const app = composeAppLikeIndex();
  const env = buildEnv({
    oidcIssuers: JSON.stringify([
      {
        issuer: "https://issuer.example",
        jwks_uri: "https://issuer.example/jwks",
        audience: "aud-1",
      },
    ]),
  });
  const res = await app.fetch(
    new Request("http://localhost/v1/auth/exchange-oidc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    env,
    execCtx(),
  );
  // The decisive assertion: bearer middleware did NOT short-circuit.
  expect(res.status).not.toBe(401);
  // It should land on the body-validation 400 instead.
  expect(res.status).toBe(400);
  const body = (await res.json()) as any;
  expect(body.error).toBe("invalid_request");
  expect(body.error_description).not.toContain("missing_authorization");
});

test("C-Carveout-Wiring: a different /v1 path with no bearer is still 401'd by middleware", async () => {
  // Sanity: the bearer middleware is active for non-carved-out /v1 paths.
  const app = composeAppLikeIndex();
  const env = buildEnv();
  const res = await app.fetch(
    new Request("http://localhost/v1/notify", { method: "POST" }),
    env,
    execCtx(),
  );
  expect(res.status).toBe(401);
});
