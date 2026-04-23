import { test, expect } from "bun:test";
import { config } from "./config";

/**
 * E2E test for admin revoke endpoint (remote mode only)
 * Requires TEST_ADMIN_REVOKE_TOKEN and TEST_REVOKE_GRANT_ID environment variables
 *
 * Run: TEST_BASE_URL=https://... TEST_ADMIN_REVOKE_TOKEN=... TEST_REVOKE_GRANT_ID=... bun test test/e2e/revoke.test.ts
 */

const TEST_ADMIN_REVOKE_TOKEN = process.env.TEST_ADMIN_REVOKE_TOKEN;
const TEST_REVOKE_GRANT_ID = process.env.TEST_REVOKE_GRANT_ID;

const shouldSkip = !config.isRemote || !TEST_ADMIN_REVOKE_TOKEN || !TEST_REVOKE_GRANT_ID;

if (shouldSkip) {
  test.skip("admin revoke E2E: requires TEST_ADMIN_REVOKE_TOKEN, TEST_REVOKE_GRANT_ID in remote mode", () => {});
} else {
  test("admin revoke E2E: endpoint returns success for valid grantId", async () => {
    const revokeRes = await fetch(`${config.baseUrl}/admin/revoke`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_ADMIN_REVOKE_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ grantId: TEST_REVOKE_GRANT_ID }),
    });

    expect(revokeRes.status).toBe(200);
    const revokeData = await revokeRes.json();
    expect(revokeData).toEqual({ ok: true, grantId: TEST_REVOKE_GRANT_ID });
  });
}
