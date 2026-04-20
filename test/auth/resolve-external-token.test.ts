import { test, expect } from "bun:test";
import { resolveExternalToken } from "../../src/auth/resolve-external-token.js";
import type { ResolveExternalTokenInput } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../../src/types.js";

const mockEnv: Partial<Env> = {
  MCP_AUTH_TOKEN: "tok-123",
};

test("resolveExternalToken returns result with matching token", async () => {
  const input: ResolveExternalTokenInput = {
    token: "tok-123",
    request: new Request("https://example.com/mcp"),
    env: mockEnv,
  };

  const result = await resolveExternalToken(input);

  expect(result).not.toBeNull();
  expect(result?.props).toBeDefined();
  expect(result?.props.legacy).toBe(true);
  expect(result?.props.userId).toBe("legacy-bearer");
  expect(result?.props.scopes).toEqual(["dovecote:notify"]);
});

test("resolveExternalToken returns null with wrong token", async () => {
  const input: ResolveExternalTokenInput = {
    token: "wrong",
    request: new Request("https://example.com/mcp"),
    env: mockEnv,
  };

  const result = await resolveExternalToken(input);
  expect(result).toBeNull();
});

test("resolveExternalToken returns null with empty token", async () => {
  const input: ResolveExternalTokenInput = {
    token: "",
    request: new Request("https://example.com/mcp"),
    env: mockEnv,
  };

  const result = await resolveExternalToken(input);
  expect(result).toBeNull();
});

test("resolveExternalToken returns null when MCP_AUTH_TOKEN is not set", async () => {
  const input: ResolveExternalTokenInput = {
    token: "tok-123",
    request: new Request("https://example.com/mcp"),
    env: { MCP_AUTH_TOKEN: "" },
  };

  const result = await resolveExternalToken(input);
  expect(result).toBeNull();
});

test("resolveExternalToken is timing-safe (different lengths)", async () => {
  const input: ResolveExternalTokenInput = {
    token: "short",
    request: new Request("https://example.com/mcp"),
    env: { MCP_AUTH_TOKEN: "much-longer-token" },
  };

  const result = await resolveExternalToken(input);
  expect(result).toBeNull();
});
