import { test, expect } from "bun:test";
import app from "../src/index.js";
import { MockKV } from "./helpers/mock-kv";
import { createMockExecutionCtx } from "./helpers/mock-execution-ctx";

const mockKv = new MockKV();
const mockEnv = {
  OAUTH_PROVIDER: {},
  OAUTH_KV: mockKv,
  HMAC_PEPPER: "test-pepper-32-characters-long",
  OAUTH_PASSWORD: "test-password",
  COOKIE_ENCRYPTION_KEY: "test-encryption-key",
} as any;
const mockCtx = createMockExecutionCtx(null) as any;

test("Contract B: GET /health returns 200 with status and timestamp", async () => {
  const req = new Request("http://localhost/health");
  const res = await app.fetch(req, mockEnv, mockCtx);
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.status).toBe("ok");
  expect(typeof body.timestamp).toBe("string");
  expect(new Date(body.timestamp).getTime()).not.toBeNaN();
});

test("Contract D: /v1/* returns 401 fail-closed", async () => {
  const req1 = new Request("http://localhost/v1/foo");
  const res1 = await app.fetch(req1, mockEnv, mockCtx);
  expect(res1.status).toBe(401);
  const body1 = (await res1.json()) as any;
  expect(body1.error).toBe("unauthorized");
  expect(["missing_authorization", "malformed_bearer", "invalid_token"]).toContain(
    body1.error_description
  );

  const req2 = new Request("http://localhost/v1/notify", {
    headers: { Authorization: "Bearer some-token" },
  });
  const res2 = await app.fetch(req2, mockEnv, mockCtx);
  expect(res2.status).toBe(401);
  const body2 = (await res2.json()) as any;
  expect(body2.error).toBe("unauthorized");
  expect(["missing_authorization", "malformed_bearer", "invalid_token"]).toContain(
    body2.error_description
  );
});

test("Contract E: Unknown paths return 404", async () => {
  const req = new Request("http://localhost/unknown-path");
  const res = await app.fetch(req, mockEnv, mockCtx);
  expect(res.status).toBe(404);
});

test("Contract A: app.fetch signature is compatible", async () => {
  const req = new Request("http://localhost/health");
  const res = await app.fetch(req, mockEnv, mockCtx);
  expect(res).toBeInstanceOf(Response);
});
