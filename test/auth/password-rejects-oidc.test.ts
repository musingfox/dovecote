import { test, expect } from "bun:test";
import { authenticateUserCredentials } from "../../src/auth/authenticate.js";
import { MockKV } from "../helpers/mock-kv.js";
import type { Env } from "../../src/types.js";

// C-PasswordRejectsOidcAlgo (end-to-end leg).
// A KV record whose `algo` is "oidc" (i.e. an OIDC auto-provisioned account)
// MUST NOT be authenticated by the form-credential path, even when the
// submitted password matches the empty placeholder hash.
test("authenticateUserCredentials returns null for algo:\"oidc\" KV record", async () => {
  const kv = new MockKV();
  await kv.put(
    "user:alice",
    JSON.stringify({
      username: "alice",
      algo: "oidc",
      iterations: 0,
      salt: "",
      hash: "",
      scopes: ["dovecote:notify"],
    }),
  );
  const env: Env = {
    OAUTH_KV: kv as any,
    OAUTH_PASSWORD: "",
    COOKIE_ENCRYPTION_KEY: "x".repeat(32),
    HMAC_PEPPER: "pep",
  };

  const got = await authenticateUserCredentials(
    { submittedUsername: "alice", submittedPassword: "" },
    env,
  );
  expect(got).toBeNull();
});
