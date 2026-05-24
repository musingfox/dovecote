import { z } from "zod";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const REDIRECT_URI_POLICY_ERROR =
  "HTTP redirect_uris must be loopback (127.0.0.1, localhost, [::1]); use HTTPS otherwise";

// Cross-checks raw URI authority against URL().hostname to defeat WHATWG
// normalisations (e.g. LOCALHOST → localhost lowercase) that would otherwise
// let case/encoding variants slip past the strict LOOPBACK_HOSTS allowlist.
function rawHostnameFromUri(uri: string): string | undefined {
  const schemeEnd = uri.indexOf("://");
  if (schemeEnd === -1) return undefined;

  const authorityStart = schemeEnd + 3;
  const authorityRemainder = uri.slice(authorityStart);
  const authorityEnd = authorityRemainder.search(/[/?#]/);
  const authority =
    authorityEnd === -1
      ? authorityRemainder
      : authorityRemainder.slice(0, authorityEnd);
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);

  if (hostPort.startsWith("[")) {
    const bracketEnd = hostPort.indexOf("]");
    return bracketEnd === -1 ? undefined : hostPort.slice(0, bracketEnd + 1);
  }

  return hostPort.split(":")[0];
}

function isAllowedRedirectUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;

    const rawHostname = rawHostnameFromUri(uri);
    if (rawHostname === undefined) return false;

    return (
      rawHostname === url.hostname &&
      LOOPBACK_HOSTS.has(url.hostname) &&
      LOOPBACK_HOSTS.has(rawHostname)
    );
  } catch {
    return false;
  }
}

/**
 * Schema for bootstrap request body (Contract Bootstrap-Schema)
 * - clientName must be non-empty string, max 128 chars
 * - redirectUris must be array of valid URLs, at least one
 * - redirectUris allow HTTPS, or HTTP only for exact loopback hosts
 */
const bootstrapBodySchema = z.object({
  clientName: z.string().min(1).max(128),
  redirectUris: z
    .array(z.string().url())
    .min(1)
    .refine((uris) => uris.every(isAllowedRedirectUri), {
      message: REDIRECT_URI_POLICY_ERROR,
    }),
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
