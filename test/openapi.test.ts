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

// OpenApiSurfaceSync (T1): given regenerated openapi.json -> paths lack the three
// removed auth paths, include /v1/auth/whoami (200 WhoamiResponse); components
// lack Device* , include WhoamiResponse.
test("OpenApiSurfaceSync: regenerated spec drops removed auth paths and gains /v1/auth/whoami", async () => {
  const tmp = `/tmp/openapi-sync-${process.pid}-${Date.now()}.json`;
  const proc = Bun.spawnSync(["bun", "scripts/generate-openapi.mjs", "--out", tmp]);
  expect(proc.exitCode).toBe(0);
  const spec = await Bun.file(tmp).json();
  expect(spec.paths).not.toHaveProperty("/v1/auth/exchange-oidc");
  expect(spec.paths).not.toHaveProperty("/v1/auth/device-authorize");
  expect(spec.paths).not.toHaveProperty("/v1/auth/exchange-device");
  expect(spec.paths).toHaveProperty("/v1/auth/whoami");
  const op = spec.paths["/v1/auth/whoami"].get;
  expect(op).toBeDefined();
  expect(op.responses).toHaveProperty("200");
  expect(op.responses["200"].content["application/json"].schema.$ref).toContain(
    "WhoamiResponse"
  );
  expect(spec.components.schemas).not.toHaveProperty("DeviceAuthorizeRequest");
  expect(spec.components.schemas).toHaveProperty("WhoamiResponse");
});

// T2: drift-gate (fresh vs committed) byte-identical. (existing test below)
