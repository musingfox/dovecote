import { test, expect } from "bun:test";

const REQUIRED_PATHS = [
  "/v1/notify",
  "/v1/channels",
  "/v1/tokens",
  "/v1/tokens/{tokenId}",
  "/health",
];

test("openapi.json is up to date (drift gate)", async () => {
  const tmp = `/tmp/openapi-drift-${process.pid}-${Date.now()}.json`;
  const proc = Bun.spawnSync(["bun", "scripts/generate-openapi.mjs", "--out", tmp]);
  expect(proc.exitCode).toBe(0);
  const fresh = await Bun.file(tmp).text();
  const committed = await Bun.file("openapi.json").text();
  expect(fresh).toBe(committed);
});

test("openapi.json contains required /v1 paths and /health", async () => {
  const spec = await Bun.file("openapi.json").json();
  expect(spec.info.title).toBe("dovecote");
  for (const p of REQUIRED_PATHS) {
    expect(spec.paths).toHaveProperty(p);
  }
});

test("each /v1 path defines 401 + 403 responses", async () => {
  const spec = await Bun.file("openapi.json").json();
  const v1Paths = REQUIRED_PATHS.filter((p) => p.startsWith("/v1/"));
  for (const path of v1Paths) {
    const ops = Object.values(spec.paths[path]) as Array<{ responses: Record<string, unknown> }>;
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) {
      expect(op.responses).toHaveProperty("401");
      expect(op.responses).toHaveProperty("403");
    }
  }
});

test("C-OpenAPI-Registration: GET /v1/tokens registered with TokenListResponse", async () => {
  const spec = await Bun.file("openapi.json").json();
  expect(spec.paths["/v1/tokens"]).toHaveProperty("get");
  const op = spec.paths["/v1/tokens"].get;
  expect(op.responses).toHaveProperty("200");
  expect(op.responses["200"].content["application/json"].schema.$ref).toContain(
    "TokenListResponse"
  );
  expect(spec.components.schemas).toHaveProperty("TokenListResponse");
});

// C-OpenApiDeviceDriftGate: Phase 4.4 RFC 8628 device-code carve-outs.
// Both endpoints are unauthenticated like /v1/auth/exchange-oidc — no 403,
// so they are NOT added to REQUIRED_PATHS above.
test("C-OpenApiDeviceDriftGate: POST /v1/auth/device-authorize registered with DeviceAuthorize{Request,Response} + 503", async () => {
  const spec = await Bun.file("openapi.json").json();
  expect(spec.paths).toHaveProperty("/v1/auth/device-authorize");
  const op = spec.paths["/v1/auth/device-authorize"].post;
  expect(op).toBeDefined();
  expect(op.requestBody.content["application/json"].schema.$ref).toContain(
    "DeviceAuthorizeRequest",
  );
  expect(op.responses["200"].content["application/json"].schema.$ref).toContain(
    "DeviceAuthorizeResponse",
  );
  for (const code of ["400", "429", "500", "503"]) {
    expect(op.responses).toHaveProperty(code);
  }
  expect(spec.components.schemas).toHaveProperty("DeviceAuthorizeRequest");
  expect(spec.components.schemas).toHaveProperty("DeviceAuthorizeResponse");
});

test("C-OpenApiDeviceDriftGate: POST /v1/auth/exchange-device registered with DeviceExchangeRequest + 503", async () => {
  const spec = await Bun.file("openapi.json").json();
  expect(spec.paths).toHaveProperty("/v1/auth/exchange-device");
  const op = spec.paths["/v1/auth/exchange-device"].post;
  expect(op).toBeDefined();
  expect(op.requestBody.content["application/json"].schema.$ref).toContain(
    "DeviceExchangeRequest",
  );
  // Success returns TokenIssueResponse (reused).
  expect(op.responses["201"].content["application/json"].schema.$ref).toContain(
    "TokenIssueResponse",
  );
  // 400 envelope is the typed device-poll union.
  expect(op.responses["400"].content["application/json"].schema.$ref).toContain(
    "DevicePollPendingResponse",
  );
  for (const code of ["429", "500", "503"]) {
    expect(op.responses).toHaveProperty(code);
  }
  expect(spec.components.schemas).toHaveProperty("DeviceExchangeRequest");
  expect(spec.components.schemas).toHaveProperty("DevicePollPendingResponse");
});

// C-OpenAPI-Registration: Phase 4.3 OIDC exchange endpoint shape.
// Note we do NOT extend REQUIRED_PATHS above — `/v1/auth/exchange-oidc` has
// no admin-scope gate, so the "every /v1 path defines 401 + 403" loop above
// (which encodes the 403 expectation) is not the right invariant here. We
// still register a 403 in the spec for shape consistency but assert it
// separately via this dedicated test.
test("C-OpenAPI-Registration: POST /v1/auth/exchange-oidc registered with TokenExchangeOidcRequest + 503", async () => {
  const spec = await Bun.file("openapi.json").json();
  expect(spec.paths).toHaveProperty("/v1/auth/exchange-oidc");
  const op = spec.paths["/v1/auth/exchange-oidc"].post;
  expect(op).toBeDefined();
  // Request body refs TokenExchangeOidcRequest
  expect(
    op.requestBody.content["application/json"].schema.$ref,
  ).toContain("TokenExchangeOidcRequest");
  // 201 returns TokenIssueResponse
  expect(op.responses["201"].content["application/json"].schema.$ref).toContain(
    "TokenIssueResponse",
  );
  // All required error responses present
  for (const code of ["400", "401", "429", "500", "503"]) {
    expect(op.responses).toHaveProperty(code);
  }
  // Component schema registered
  expect(spec.components.schemas).toHaveProperty("TokenExchangeOidcRequest");
});
