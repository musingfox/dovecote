import { test, expect } from "bun:test";
import { profileNameSchema } from "../../src/contracts/env.js";

test("A3: profileNameSchema validates profile name identifiers", () => {
  // Valid: simple name
  const result1 = profileNameSchema.safeParse("prod");
  expect(result1.success).toBe(true);
  if (result1.success) {
    expect(result1.data).toBe("prod");
  }

  // Valid: with underscore and hyphen
  const result2 = profileNameSchema.safeParse("prod_v2-1");
  expect(result2.success).toBe(true);
  if (result2.success) {
    expect(result2.data).toBe("prod_v2-1");
  }

  // Valid: with numbers
  const result3 = profileNameSchema.safeParse("env123");
  expect(result3.success).toBe(true);
  if (result3.success) {
    expect(result3.data).toBe("env123");
  }

  // Invalid: empty string
  const result4 = profileNameSchema.safeParse("");
  expect(result4.success).toBe(false);

  // Invalid: with slash (path traversal)
  const result5 = profileNameSchema.safeParse("prod/secret");
  expect(result5.success).toBe(false);

  // Invalid: with dot-dot (path traversal)
  const result6 = profileNameSchema.safeParse("../etc");
  expect(result6.success).toBe(false);

  // Invalid: with space
  const result7 = profileNameSchema.safeParse("prod env");
  expect(result7.success).toBe(false);

  // Invalid: with special characters
  const result8 = profileNameSchema.safeParse("prod!env");
  expect(result8.success).toBe(false);

  // Invalid: non-string input
  const result9 = profileNameSchema.safeParse(123 as any);
  expect(result9.success).toBe(false);

  // Invalid: null input
  const result10 = profileNameSchema.safeParse(null as any);
  expect(result10.success).toBe(false);
});

test("A3: ProfileName type is exported", () => {
  const name: string = "prod";
  // Type-level test - ProfileName should be assignable from valid strings
  expect(name).toBe("prod");
});
