import { test, expect } from "bun:test";
import { enrichAuthFromRequest, ANONYMOUS } from "../../src/auth/ctx";

test("enrichAuthFromRequest with CF-Connecting-IP header + oauth", () => {
  const request = new Request("https://x", {
    headers: { "CF-Connecting-IP": "1.2.3.4" },
  });

  const result = enrichAuthFromRequest(ANONYMOUS, request, "oauth");
  expect(result).toEqual({
    ...ANONYMOUS,
    authMethod: "oauth",
    ip: "1.2.3.4",
  });
});

test("enrichAuthFromRequest with missing header falls back to 'unknown'", () => {
  const request = new Request("https://x");

  const result = enrichAuthFromRequest(ANONYMOUS, request, "oauth");
  expect(result).toEqual({
    ...ANONYMOUS,
    authMethod: "oauth",
    ip: "unknown",
  });
});

test("enrichAuthFromRequest is case-insensitive on header + passes tokenId for api_token", () => {
  const auth = {
    userId: "u",
    scopes: ["dovecote:notify"],
    authMethod: "none" as const,
    ip: "unknown",
  };
  const request = new Request("https://x", {
    headers: { "cf-connecting-ip": "5.6.7.8" },
  });

  const result = enrichAuthFromRequest(auth, request, "api_token", "t_1");
  expect(result).toEqual({
    userId: "u",
    scopes: ["dovecote:notify"],
    authMethod: "api_token",
    ip: "5.6.7.8",
    tokenId: "t_1",
  });
});

test("enrichAuthFromRequest does not sanitize IP value", () => {
  // Bun's Request constructor rejects header values containing CRLF, so we
  // duck-type the Request to feed an unsanitized raw value into the helper.
  // The helper's contract: it must NOT sanitize — that's writeAudit's job.
  const request = {
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "cf-connecting-ip" ? "1.2.3.4\nINJECT" : null,
    },
  } as unknown as Request;

  const result = enrichAuthFromRequest(ANONYMOUS, request, "oauth");
  expect(result.ip).toBe("1.2.3.4\nINJECT");
});
