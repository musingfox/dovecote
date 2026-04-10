import { readFileSync } from "fs";
import { resolve } from "path";
import type { Env } from "../../src/types";

export interface E2EConfig {
  baseUrl: string;
  isRemote: boolean;
  authToken: string;
  env: Env;
}

function parseDevVars(path: string): Record<string, string> {
  const content = readFileSync(path, "utf-8");
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

function loadConfig(): E2EConfig {
  const testBaseUrl = process.env.TEST_BASE_URL;
  const testAuthToken = process.env.TEST_AUTH_TOKEN;

  // Remote mode
  if (testBaseUrl) {
    if (!testAuthToken) {
      throw new Error("TEST_AUTH_TOKEN is required when TEST_BASE_URL is set");
    }
    return {
      baseUrl: testBaseUrl,
      isRemote: true,
      authToken: testAuthToken,
      env: {
        MCP_AUTH_TOKEN: testAuthToken,
      },
    };
  }

  // Local mode - read from .dev.vars
  const varsPath = resolve(import.meta.dir, "../../.dev.vars");
  const vars = parseDevVars(varsPath);

  if (!vars.MCP_AUTH_TOKEN) {
    throw new Error("Missing MCP_AUTH_TOKEN in .dev.vars");
  }

  return {
    baseUrl: "http://localhost",
    isRemote: false,
    authToken: vars.MCP_AUTH_TOKEN,
    env: {
      MCP_AUTH_TOKEN: vars.MCP_AUTH_TOKEN,
      TELEGRAM_BOT_TOKEN: vars.TELEGRAM_BOT_TOKEN,
      TELEGRAM_CHAT_ID: vars.TELEGRAM_CHAT_ID,
      DISCORD_WEBHOOK_URL: vars.DISCORD_WEBHOOK_URL,
    },
  };
}

export const config = loadConfig();
