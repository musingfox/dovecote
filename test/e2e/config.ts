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

function parseDevVars(path: string): Record<string, string> {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
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

function deriveExpectedChannels(env: Env): string[] {
  const channels: string[] = [];

  if (env.TELEGRAM_INSTANCES) {
    try {
      const parsed = JSON.parse(env.TELEGRAM_INSTANCES);
      if (Array.isArray(parsed)) {
        for (const instance of parsed) {
          if (instance.id) {
            channels.push(`telegram-${instance.id.toLowerCase()}`);
          }
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  if (env.DISCORD_INSTANCES) {
    try {
      const parsed = JSON.parse(env.DISCORD_INSTANCES);
      if (Array.isArray(parsed)) {
        for (const instance of parsed) {
          if (instance.id) {
            channels.push(`discord-${instance.id.toLowerCase()}`);
          }
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  return channels;
}

function loadConfig(): E2EConfig {
  const testBaseUrl = process.env.TEST_BASE_URL;
  const testAuthToken = process.env.TEST_AUTH_TOKEN;

  // Remote mode
  if (testBaseUrl) {
    // Read JSON env vars if provided, else construct from individual env vars for convenience
    let telegramInstances = process.env.TEST_TELEGRAM_INSTANCES;
    let discordInstances = process.env.TEST_DISCORD_INSTANCES;

    if (!telegramInstances && process.env.TEST_TELEGRAM_BOT_TOKEN && process.env.TEST_TELEGRAM_CHAT_ID) {
      telegramInstances = JSON.stringify([{
        id: "default",
        botToken: process.env.TEST_TELEGRAM_BOT_TOKEN,
        chatId: process.env.TEST_TELEGRAM_CHAT_ID,
      }]);
    }

    if (!discordInstances && process.env.TEST_DISCORD_WEBHOOK_URL) {
      discordInstances = JSON.stringify([{
        id: "default",
        webhookUrl: process.env.TEST_DISCORD_WEBHOOK_URL,
      }]);
    }

    const env: Env = {
      TELEGRAM_INSTANCES: telegramInstances,
      DISCORD_INSTANCES: discordInstances,
      OAUTH_KV: {} as any,
      OAUTH_PASSWORD: process.env.TEST_OAUTH_PASSWORD || "test-password",
      COOKIE_ENCRYPTION_KEY: process.env.TEST_COOKIE_ENCRYPTION_KEY || "test-key-32-bytes-minimum-length-required",
      HMAC_PEPPER: "test-pepper",
      ADMIN_REVOKE_TOKEN: process.env.TEST_ADMIN_REVOKE_TOKEN,
    };

    return {
      baseUrl: testBaseUrl,
      isRemote: true,
      authToken: testAuthToken || null,
      env,
      expectedChannels: deriveExpectedChannels(env),
    };
  }

  // Local mode - read from .dev.vars
  const varsPath = resolve(import.meta.dir, "../../.dev.vars");
  const vars = parseDevVars(varsPath);

  const env: Env = {
    TELEGRAM_INSTANCES: vars.TELEGRAM_INSTANCES,
    DISCORD_INSTANCES: vars.DISCORD_INSTANCES,
    OAUTH_KV: new MockKV() as any,
    OAUTH_PASSWORD: vars.OAUTH_PASSWORD || "test-password",
    COOKIE_ENCRYPTION_KEY:
      vars.COOKIE_ENCRYPTION_KEY || "test-key-32-bytes-minimum-length-required",
    HMAC_PEPPER: vars.HMAC_PEPPER || "test-pepper",
    ADMIN_REVOKE_TOKEN: vars.ADMIN_REVOKE_TOKEN || "admin-test-token",
    ENABLE_CLIENT_BOOTSTRAP: vars.ENABLE_CLIENT_BOOTSTRAP || "1",
  };

  return {
    baseUrl: "http://localhost:8787",
    isRemote: false,
    authToken: null,
    env,
    expectedChannels: deriveExpectedChannels(env),
  };
}

export const config = loadConfig();
