import { test, expect } from "bun:test";
import { tokenExchangeOidcRequestSchema } from "../../src/contracts/tokens.js";

// C-Schema-OidcRequest: zod schema validating the POST /v1/auth/exchange-oidc
// request body. Schema is strict-by-omission (unknown fields ignored).

test("C-Schema-OidcRequest: minimal valid body parses", () => {
  const r = tokenExchangeOidcRequestSchema.safeParse({ id_token: "abc.def.ghi" });
  expect(r.success).toBe(true);
  if (r.success) {
    expect(r.data.id_token).toBe("abc.def.ghi");
    expect(r.data.expiresIn).toBeUndefined();
    expect(r.data.label).toBeUndefined();
  }
});

test("C-Schema-OidcRequest: full body with expiresIn + label parses", () => {
  const r = tokenExchangeOidcRequestSchema.safeParse({
    id_token: "abc.def.ghi",
    expiresIn: "7d",
    label: "laptop",
  });
  expect(r.success).toBe(true);
  if (r.success) {
    expect(r.data.expiresIn).toBe("7d");
    expect(r.data.label).toBe("laptop");
  }
});

test("C-Schema-OidcRequest: missing id_token fails", () => {
  const r = tokenExchangeOidcRequestSchema.safeParse({});
  expect(r.success).toBe(false);
});

test("C-Schema-OidcRequest: empty id_token fails (min 1)", () => {
  const r = tokenExchangeOidcRequestSchema.safeParse({ id_token: "" });
  expect(r.success).toBe(false);
});

test("C-Schema-OidcRequest: bad expiresIn enum fails", () => {
  const r = tokenExchangeOidcRequestSchema.safeParse({
    id_token: "x",
    expiresIn: "30days",
  });
  expect(r.success).toBe(false);
});

test("C-Schema-OidcRequest: label > 64 fails", () => {
  const r = tokenExchangeOidcRequestSchema.safeParse({
    id_token: "x",
    label: "y".repeat(65),
  });
  expect(r.success).toBe(false);
});
