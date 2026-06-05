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

export async function initMiniflare(
  oidcBindings?: Record<string, string>,
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
      OAUTH_PASSWORD: "test-password",
      COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length-required",
      ADMIN_REVOKE_TOKEN: "admin-token-123",
      ENABLE_CLIENT_BOOTSTRAP: "1",
      ...(oidcBindings ?? {}),
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
