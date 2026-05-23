import { test, expect } from "bun:test";

// C-Dependency-Jose: package.json carries `jose` as a direct dependency
// with a pinned `overrides` entry, and the runtime module exposes the
// primitives the OIDC verify path needs.
test("C-Dependency-Jose: package.json has dependencies.jose + overrides.jose", async () => {
  const pkg = await Bun.file("package.json").json();
  expect(pkg.dependencies?.jose).toBe("^6.2.2");
  expect(pkg.overrides?.jose).toBe("6.2.2");
});

test("C-Dependency-Jose: jose module exposes jwtVerify and createRemoteJWKSet", async () => {
  const jose = await import("jose");
  expect(typeof jose.jwtVerify).toBe("function");
  expect(typeof jose.createRemoteJWKSet).toBe("function");
});
