import { test, expect } from "bun:test";
import { validateBootstrapBody } from "../../src/auth/bootstrap-schema.js";

const REDIRECT_URI_POLICY_ERROR =
  "HTTP redirect_uris must be loopback (127.0.0.1, localhost, [::1]); use HTTPS otherwise";

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

test("bootstrap schema: HTTPS redirectUri succeeds", async () => {
  const body = {
    clientName: "a",
    redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
  };

  const result = validateBootstrapBody(body);

  expect(result).toEqual({
    success: true,
    data: {
      clientName: "a",
      redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    },
  });
});

test("bootstrap schema: 127.0.0.1 HTTP redirectUri succeeds", async () => {
  const body = {
    clientName: "a",
    redirectUris: ["http://127.0.0.1:9999/cb"],
  };

  const result = validateBootstrapBody(body);

  expect(result).toEqual({
    success: true,
    data: {
      clientName: "a",
      redirectUris: ["http://127.0.0.1:9999/cb"],
    },
  });
});

test("bootstrap schema: localhost HTTP redirectUri succeeds", async () => {
  const body = {
    clientName: "a",
    redirectUris: ["http://localhost:3000/callback"],
  };

  const result = validateBootstrapBody(body);

  expect(result).toEqual({
    success: true,
    data: {
      clientName: "a",
      redirectUris: ["http://localhost:3000/callback"],
    },
  });
});

test("bootstrap schema: IPv6 loopback HTTP redirectUri succeeds", async () => {
  const body = {
    clientName: "a",
    redirectUris: ["http://[::1]/cb"],
  };

  const result = validateBootstrapBody(body);

  expect(result).toEqual({
    success: true,
    data: {
      clientName: "a",
      redirectUris: ["http://[::1]/cb"],
    },
  });
});

test("bootstrap schema: attacker HTTP redirectUri fails", async () => {
  const body = {
    clientName: "a",
    redirectUris: ["http://attacker.com/cb"],
  };

  const result = validateBootstrapBody(body);

  expect(result).toEqual({
    success: false,
    error: REDIRECT_URI_POLICY_ERROR,
  });
});

test("bootstrap schema: mixed HTTPS and attacker HTTP redirectUris fail once", async () => {
  const body = {
    clientName: "a",
    redirectUris: ["https://ok.com/cb", "http://attacker.com/cb"],
  };

  const result = validateBootstrapBody(body);

  expect(result).toEqual({
    success: false,
    error: REDIRECT_URI_POLICY_ERROR,
  });
});

test("bootstrap schema: uppercase localhost HTTP redirectUri fails", async () => {
  const body = {
    clientName: "a",
    redirectUris: ["http://LOCALHOST/cb"],
  };

  const result = validateBootstrapBody(body);

  expect(result).toEqual({
    success: false,
    error: REDIRECT_URI_POLICY_ERROR,
  });
});

test("bootstrap schema: non-literal 127 loopback HTTP redirectUri fails", async () => {
  const body = {
    clientName: "a",
    redirectUris: ["http://127.0.0.2/cb"],
  };

  const result = validateBootstrapBody(body);

  expect(result).toEqual({
    success: false,
    error: REDIRECT_URI_POLICY_ERROR,
  });
});
