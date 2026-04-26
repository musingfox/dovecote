import { test, expect } from "bun:test";
import { generateCSRF, validateCSRF } from "../../src/auth/csrf.js";

test("generateCSRF returns token and cookie", async () => {
  const secretKey = "s3cret-32b-min...........................";
  const { token, cookie } = await generateCSRF({ secretKey });

  expect(token).toBeTruthy();
  expect(typeof token).toBe("string");
  expect(token.length).toBeGreaterThan(0);

  expect(cookie).toBeTruthy();
  expect(cookie).toContain("csrf=");
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("Path=/");
  expect(cookie).toContain("SameSite=Lax");
});

test("validateCSRF returns true with matching token and cookie", async () => {
  const secretKey = "s3cret-32b-min...........................";
  const { token, cookie } = await generateCSRF({ secretKey });

  // Extract cookie value from Set-Cookie header
  const cookieValue = cookie.split(";")[0]!.split("=")[1]!;

  // Create a request with matching form data and cookie
  const formData = new FormData();
  formData.append("csrf_token", token);

  const request = new Request("https://example.com/authorize", {
    method: "POST",
    headers: {
      Cookie: `csrf=${cookieValue}`,
    },
    body: formData,
  });

  const isValid = await validateCSRF({ request, secretKey });
  expect(isValid).toBe(true);
});

test("validateCSRF returns false with mismatched token", async () => {
  const secretKey = "s3cret-32b-min...........................";
  const { cookie } = await generateCSRF({ secretKey });

  // Extract cookie value
  const cookieValue = cookie.split(";")[0]!.split("=")[1]!;

  // Create request with different token
  const formData = new FormData();
  formData.append("csrf_token", "wrong-token");

  const request = new Request("https://example.com/authorize", {
    method: "POST",
    headers: {
      Cookie: `csrf=${cookieValue}`,
    },
    body: formData,
  });

  const isValid = await validateCSRF({ request, secretKey });
  expect(isValid).toBe(false);
});

test("validateCSRF returns false with no cookie header", async () => {
  const secretKey = "s3cret-32b-min...........................";
  const { token } = await generateCSRF({ secretKey });

  const formData = new FormData();
  formData.append("csrf_token", token);

  const request = new Request("https://example.com/authorize", {
    method: "POST",
    body: formData,
  });

  const isValid = await validateCSRF({ request, secretKey });
  expect(isValid).toBe(false);
});

test("validateCSRF returns false with no csrf_token in form", async () => {
  const secretKey = "s3cret-32b-min...........................";
  const { cookie } = await generateCSRF({ secretKey });

  const cookieValue = cookie.split(";")[0]!.split("=")[1]!;

  const formData = new FormData();
  // No csrf_token in form

  const request = new Request("https://example.com/authorize", {
    method: "POST",
    headers: {
      Cookie: `csrf=${cookieValue}`,
    },
    body: formData,
  });

  const isValid = await validateCSRF({ request, secretKey });
  expect(isValid).toBe(false);
});
