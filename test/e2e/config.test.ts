import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { parseDevVars, parseExpectedChannels } from "./config";

describe("E2E Config", () => {
  let originalBaseUrl: string | undefined;
  let originalAuthToken: string | undefined;
  let originalExpectedChannels: string | undefined;

  beforeEach(() => {
    // Save original env vars
    originalBaseUrl = process.env.TEST_BASE_URL;
    originalAuthToken = process.env.TEST_AUTH_TOKEN;
    originalExpectedChannels = process.env.TEST_EXPECTED_CHANNELS;
  });

  afterEach(() => {
    if (originalExpectedChannels === undefined) {
      delete process.env.TEST_EXPECTED_CHANNELS;
    } else {
      process.env.TEST_EXPECTED_CHANNELS = originalExpectedChannels;
    }

    // Restore original env vars
    if (originalBaseUrl === undefined) {
      delete process.env.TEST_BASE_URL;
    } else {
      process.env.TEST_BASE_URL = originalBaseUrl;
    }

    if (originalAuthToken === undefined) {
      delete process.env.TEST_AUTH_TOKEN;
    } else {
      process.env.TEST_AUTH_TOKEN = originalAuthToken;
    }

    // Clear module cache to force reload
    delete require.cache[require.resolve("./config")];
  });

  it("parseDevVars returns {} for nonexistent path", () => {
    const result = parseDevVars("/nonexistent/__spiral_probe__/x");
    expect(result).toEqual({});
  });

  it("parseDevVars rethrows non-ENOENT errors", () => {
    expect(() => parseDevVars(import.meta.dir)).toThrow();
    let thrown: unknown;
    try {
      parseDevVars(import.meta.dir);
    } catch (e) {
      thrown = e;
    }
    expect((thrown as { code?: string }).code).toBe("EISDIR");
  });

  it("loads local mode config when no TEST_BASE_URL", () => {
    delete process.env.TEST_BASE_URL;
    delete process.env.TEST_AUTH_TOKEN;

    // Force reload the module
    delete require.cache[require.resolve("./config")];
    const { config } = require("./config");

    expect(config.isRemote).toBe(false);
    expect(config.baseUrl).toBe("http://localhost:8787");
    expect(config.authToken).toBeNull();
  });

  it("loads remote mode config when TEST_BASE_URL and TEST_AUTH_TOKEN are set", () => {
    process.env.TEST_BASE_URL = "https://example.com";
    process.env.TEST_AUTH_TOKEN = "test-token";

    // Force reload the module
    delete require.cache[require.resolve("./config")];
    const { config } = require("./config");

    expect(config.isRemote).toBe(true);
    expect(config.baseUrl).toBe("https://example.com");
    expect(config.authToken).toBe("test-token");
  });

  // ChannelEnvBindingRemovedFromWorker T2 — channels are no longer derivable
  // from anything this process can see, so an unstated expectation is empty.
  it("expectedChannels is empty in local mode when TEST_EXPECTED_CHANNELS is unset", () => {
    delete process.env.TEST_BASE_URL;
    delete process.env.TEST_EXPECTED_CHANNELS;

    delete require.cache[require.resolve("./config")];
    const { config } = require("./config");

    expect(config.isRemote).toBe(false);
    expect(config.expectedChannels).toEqual([]);
  });

  // ChannelEnvBindingRemovedFromWorker T3 — the operator states the expectation.
  it("expectedChannels comes from TEST_EXPECTED_CHANNELS in remote mode", () => {
    process.env.TEST_BASE_URL = "https://example.com";
    process.env.TEST_EXPECTED_CHANNELS = "telegram-default,discord-ops";

    delete require.cache[require.resolve("./config")];
    const { config } = require("./config");

    expect(config.isRemote).toBe(true);
    expect(config.expectedChannels).toEqual(["telegram-default", "discord-ops"]);
  });

  it("parseExpectedChannels trims entries and treats empty/absent as no channels", () => {
    expect(parseExpectedChannels(undefined)).toEqual([]);
    expect(parseExpectedChannels("")).toEqual([]);
    expect(parseExpectedChannels(" telegram-a , discord-b ")).toEqual([
      "telegram-a",
      "discord-b",
    ]);
    expect(parseExpectedChannels("telegram-a,,")).toEqual(["telegram-a"]);
  });

  it("the e2e Env fixture carries no channel-configuration binding at all", () => {
    delete require.cache[require.resolve("./config")];
    const { config } = require("./config");

    // The worker reads channels from KV records only; nothing named *_INSTANCES
    // may survive on the environment object (ChannelEnvBindingRemovedFromWorker T1).
    for (const key of Object.keys(config.env)) {
      expect(key).not.toMatch(/_INSTANCES$/);
    }
  });
});
