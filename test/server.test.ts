import { describe, it, expect } from "bun:test";
import { createMCPServer } from "../src/server";
import type { Env } from "../src/types";

const mockEnv: Env = {
  MCP_AUTH_TOKEN: "test-token-123",
  OAUTH_KV: {} as any,
  OAUTH_PASSWORD: "test-password",
  COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length",
};

describe("MCP Server Factory", () => {
  it("createMCPServer returns McpServer instance with correct metadata", () => {
    const server = createMCPServer(mockEnv);

    expect((server as any).server._serverInfo.name).toBe("dovecote-mcp-server");
    expect((server as any).server._serverInfo.version).toBe("1.0.0");
  });
});
