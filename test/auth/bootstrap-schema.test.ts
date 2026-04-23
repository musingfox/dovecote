import { test, expect } from "bun:test";
import { validateBootstrapBody } from "../../src/auth/bootstrap-schema.js";

test("bootstrap schema: valid request with clientName and redirectUris", async () => {
  const body = {
    clientName: "my-app",
    redirectUris: ["https://example.com/cb"],
  };

  const result = validateBootstrapBody(body);

  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.clientName).toBe("my-app");
    expect(result.data.redirectUris).toEqual(["https://example.com/cb"]);
  }
});

test("bootstrap schema: empty object fails", async () => {
  const body = {};

  const result = validateBootstrapBody(body);

  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error).toBeTruthy();
  }
});

test("bootstrap schema: empty clientName fails", async () => {
  const body = {
    clientName: "",
    redirectUris: ["https://x.com/cb"],
  };

  const result = validateBootstrapBody(body);

  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error).toBeTruthy();
  }
});

test("bootstrap schema: empty redirectUris array fails", async () => {
  const body = {
    clientName: "app",
    redirectUris: [],
  };

  const result = validateBootstrapBody(body);

  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error).toBeTruthy();
  }
});

test("bootstrap schema: invalid URL in redirectUris fails", async () => {
  const body = {
    clientName: "app",
    redirectUris: ["not-a-url"],
  };

  const result = validateBootstrapBody(body);

  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error).toBeTruthy();
  }
});

test("bootstrap schema: clientName over 128 chars fails", async () => {
  const body = {
    clientName: "a".repeat(129),
    redirectUris: ["https://example.com/cb"],
  };

  const result = validateBootstrapBody(body);

  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error).toBeTruthy();
  }
});

test("bootstrap schema: multiple valid redirectUris succeeds", async () => {
  const body = {
    clientName: "multi-redirect-app",
    redirectUris: [
      "https://example.com/cb",
      "https://example.com/cb2",
      "http://localhost:3000/callback",
    ],
  };

  const result = validateBootstrapBody(body);

  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.clientName).toBe("multi-redirect-app");
    expect(result.data.redirectUris).toEqual([
      "https://example.com/cb",
      "https://example.com/cb2",
      "http://localhost:3000/callback",
    ]);
  }
});
