import { z } from "zod";

/**
 * Schema for bootstrap request body (Contract Bootstrap-Schema)
 * - clientName must be non-empty string, max 128 chars
 * - redirectUris must be array of valid URLs, at least one
 */
const bootstrapBodySchema = z.object({
  clientName: z.string().min(1).max(128),
  redirectUris: z.array(z.string().url()).min(1),
});

export type BootstrapValidationResult =
  | { success: true; data: { clientName: string; redirectUris: string[] } }
  | { success: false; error: string };

/**
 * Validate bootstrap request body
 * @param body - Unknown body to validate
 * @returns Validation result with parsed data or error message
 */
export function validateBootstrapBody(body: unknown): BootstrapValidationResult {
  const result = bootstrapBodySchema.safeParse(body);

  if (result.success) {
    return {
      success: true as const,
      data: {
        clientName: result.data.clientName,
        redirectUris: result.data.redirectUris,
      },
    };
  }

  // Extract first error message for human-readable output
  const errorMessage = result.error.issues[0]?.message || "Invalid request body";

  return {
    success: false as const,
    error: errorMessage,
  };
}
