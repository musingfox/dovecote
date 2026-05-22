import { z } from "zod";

/**
 * Schema for revoke request body (Contract B).
 *
 * - `grantId` must match the OAuth provider library format: base64url
 *   alphanumeric (A-Za-z0-9_-), minimum 16 chars.
 * - `userId` must match the same conservative charset enforced by the user
 *   store (lowercase letters, digits, underscore, dash; 1–64 chars).
 *   This is the user whose grant is being revoked.
 */
const revokeBodySchema = z.object({
  grantId: z.string().regex(/^[A-Za-z0-9_-]{16,}$/),
  userId: z.string().regex(/^[a-z0-9_-]{1,64}$/),
});

export type ValidationResult =
  | { success: true; data: { grantId: string; userId: string } }
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
      data: { grantId: result.data.grantId, userId: result.data.userId },
    };
  }

  // Extract first error message for human-readable output
  const errorMessage = result.error.issues[0]?.message || "Invalid request body";

  return {
    success: false as const,
    error: errorMessage,
  };
}
