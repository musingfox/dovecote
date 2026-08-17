import { readFileSync } from "fs";
import { resolve } from "path";
import type { Env } from "../../src/types";
import { MockKV } from "../helpers/mock-kv";

export interface E2EConfig {
  baseUrl: string;
  isRemote: boolean;
  authToken: string | null;
  env: Env;
  expectedChannels: string[];
}

export function parseDevVars(path: string): Record<string, string> {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") throw e;
    return {};
  }
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx > 0) {
      vars[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
    }
  }
  return vars;
}

/**
 * The channels the target worker is expected to serve, stated explicitly by the
 * operator running the suite (D-M8). Channels live as `channel:<id>` records in
 * the worker's KV namespace, which this process cannot read, so the expectation
 * is declared rather than derived — that also makes the assertion stronger: a
 * worker that lost a channel fails instead of quietly lowering the bar.
 *
 * `TEST_EXPECTED_CHANNELS="telegram-default,discord-ops"`; absent or empty → [].
 */
export function parseExpectedChannels(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function loadConfig(): E2EConfig {
  const testBaseUrl = process.env.TEST_BASE_URL;
  const testAuthToken = process.env.TEST_AUTH_TOKEN;

  // Remote mode
  if (testBaseUrl) {
    const env: Env = {
      OAUTH_KV: {} as any,
      HMAC_PEPPER: "test-pepper",
      ADMIN_REVOKE_TOKEN: process.env.TEST_ADMIN_REVOKE_TOKEN,
    };

    return {
      baseUrl: testBaseUrl,
      isRemote: true,
      authToken: testAuthToken || null,
      env,
      expectedChannels: parseExpectedChannels(process.env.TEST_EXPECTED_CHANNELS),
    };
  }

  // Local mode - read from .dev.vars
  const varsPath = resolve(import.meta.dir, "../../.dev.vars");
  const vars = parseDevVars(varsPath);

  const env: Env = {
    OAUTH_KV: new MockKV() as any,
    HMAC_PEPPER: vars.HMAC_PEPPER || "test-pepper",
    ADMIN_REVOKE_TOKEN: vars.ADMIN_REVOKE_TOKEN || "admin-test-token",
    ENABLE_CLIENT_BOOTSTRAP: vars.ENABLE_CLIENT_BOOTSTRAP || "1",
  };

  return {
    baseUrl: "http://localhost:8787",
    isRemote: false,
    authToken: null,
    env,
    expectedChannels: parseExpectedChannels(process.env.TEST_EXPECTED_CHANNELS),
  };
}

export const config = loadConfig();
