import { describe, it, expect } from "bun:test";
import { createMCPServer } from "../src/server";
import { ANONYMOUS } from "../src/auth/ctx";
import type { Env } from "../src/types";
import { createMockExecutionCtx } from "./helpers/mock-execution-ctx";

const mockEnv: Env = {
  MCP_AUTH_TOKEN: "test-token-123",
  OAUTH_KV: {} as any,
  OAUTH_PASSWORD: "test-password",
  COOKIE_ENCRYPTION_KEY: "test-key-32-bytes-minimum-length",
};

describe("MCP Server Factory", () => {
  it("createMCPServer returns McpServer instance with correct metadata (operator auth)", () => {
    const auth = { userId: "op", scopes: ["dovecote:notify"] };
    const ctx = createMockExecutionCtx({ userId: "op", scopes: ["dovecote:notify"] });

    const server = createMCPServer(mockEnv, auth, ctx as any);

    expect((server as any).server._serverInfo.name).toBe("dovecote-mcp-server");
    expect((server as any).server._serverInfo.version).toBe("1.0.0");
  });

  it("createMCPServer returns McpServer instance with ANONYMOUS auth", () => {
    const ctx = createMockExecutionCtx(null);

    const server = createMCPServer(mockEnv, ANONYMOUS, ctx as any);

    expect((server as any).server._serverInfo.name).toBe("dovecote-mcp-server");
    expect((server as any).server._serverInfo.version).toBe("1.0.0");
  });
});
