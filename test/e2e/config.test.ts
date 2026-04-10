import { describe, it, expect, beforeEach, afterEach } from "bun:test";

describe("E2E Config", () => {
  let originalBaseUrl: string | undefined;
  let originalAuthToken: string | undefined;

  beforeEach(() => {
    // Save original env vars
    originalBaseUrl = process.env.TEST_BASE_URL;
    originalAuthToken = process.env.TEST_AUTH_TOKEN;
  });

  afterEach(() => {
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

  it("throws error when TEST_BASE_URL is set but TEST_AUTH_TOKEN is missing", () => {
    process.env.TEST_BASE_URL = "https://example.com";
    delete process.env.TEST_AUTH_TOKEN;

    expect(() => {
      // Force reload the module
      delete require.cache[require.resolve("./config")];
      require("./config");
    }).toThrow("TEST_AUTH_TOKEN is required when TEST_BASE_URL is set");
  });

  it("loads local mode config when no TEST_BASE_URL", () => {
    delete process.env.TEST_BASE_URL;
    delete process.env.TEST_AUTH_TOKEN;

    // Force reload the module
    delete require.cache[require.resolve("./config")];
    const { config } = require("./config");

    expect(config.isRemote).toBe(false);
    expect(config.baseUrl).toBe("http://localhost");
    expect(config.authToken).toBeDefined();
    expect(config.env.MCP_AUTH_TOKEN).toBeDefined();
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
    expect(config.env.MCP_AUTH_TOKEN).toBe("test-token");
  });
});
