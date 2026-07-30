/**
 * Shared Miniflare setup for integration tests.
 *
 * Prerequisites:
 *   Run `bun run test:integration:build` before executing integration tests.
 *   This produces `dist-test/index.js` which is loaded here.
 */

import { Miniflare } from "miniflare";
import path from "node:path";
import fs from "node:fs";

const DIST_BUNDLE = path.resolve(
  import.meta.dir,
  "../../../dist-test/index.js",
);

let mf: Miniflare | null = null;

export function getMiniflare(): Miniflare {
  if (!mf) {
    throw new Error(
      "Miniflare not initialised — call initMiniflare() first (beforeAll).",
    );
  }
  return mf;
}

/** HMAC pepper shared between the worker binding and test-side token minting. */
export const TEST_HMAC_PEPPER = "miniflare-test-pepper-32-chars!!";

export async function initMiniflare(
  extraBindings?: Record<string, string>,
): Promise<Miniflare> {
  if (!fs.existsSync(DIST_BUNDLE)) {
    throw new Error(
      `Bundle not found at ${DIST_BUNDLE}.\n` +
        "Run `bun run test:integration:build` first.",
    );
  }

  mf = new Miniflare({
    scriptPath: DIST_BUNDLE,
    modules: true,
    compatibilityDate: "2024-01-01",
    compatibilityFlags: ["nodejs_compat"],
    kvNamespaces: ["OAUTH_KV"],
    bindings: {
      ADMIN_REVOKE_TOKEN: "admin-token-123",
      ENABLE_CLIENT_BOOTSTRAP: "1",
      HMAC_PEPPER: TEST_HMAC_PEPPER,
      ...(extraBindings ?? {}),
    },
  });

  await mf.ready;
  return mf;
}

export async function disposeMiniflare(): Promise<void> {
  if (mf) {
    await mf.dispose();
    mf = null;
  }
}

/**
 * Seed a dvct_* token straight into the worker's KV (the wizard's local-mint
 * shape: apitoken:<id> / apitoken_hash:<hash> / apitoken_user:<user>:<id>).
 * Hash = HMAC-SHA256(TEST_HMAC_PEPPER, token) hex — matches verifyToken.
 */
export async function seedDvctToken(opts: {
  userId: string;
  scopes: string[];
}): Promise<{ token: string; tokenId: string }> {
  const { createHmac, randomBytes } = await import("node:crypto");
  const tokenId = randomBytes(8).toString("base64url");
  const token = "dvct_" + randomBytes(24).toString("base64url");
  const hash = createHmac("sha256", TEST_HMAC_PEPPER).update(token).digest("hex");
  const now = Date.now();
  const metadata = JSON.stringify({
    tokenId,
    userId: opts.userId,
    scopes: opts.scopes,
    hash,
    createdAt: now,
    expiresAt: now + 7_776_000_000,
  });
  const kv = await getMiniflare().getKVNamespace("OAUTH_KV");
  await kv.put(`apitoken:${tokenId}`, metadata);
  await kv.put(`apitoken_hash:${hash}`, metadata);
  await kv.put(`apitoken_user:${opts.userId}:${tokenId}`, "");
  return { token, tokenId };
}
