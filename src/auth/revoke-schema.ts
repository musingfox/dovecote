import { z } from "zod";

/**
 * Schema for revoke request body (Contract B)
 * - grantId must be lowercase alphanumeric with hyphens, minimum 20 chars
 */
const revokeBodySchema = z.object({
  grantId: z.string().regex(/^[a-z0-9-]{20,}$/),
});

export type ValidationResult =
  | { success: true; data: { grantId: string } }
  | { success: false; error: string };

/**
 * Validate revoke request body
 * @param body - Unknown body to validate
 * @returns Validation result with parsed data or error message
 */
export function validateRevokeBody(body: unknown): ValidationResult {
  const result = revokeBodySchema.safeParse(body);

  if (result.success) {
    return {
      success: true as const,
      data: { grantId: result.data.grantId },
    };
  }

  // Extract first error message for human-readable output
  const errorMessage = result.error.issues[0]?.message || "Invalid request body";

  return {
    success: false as const,
    error: errorMessage,
  };
}
