import { z } from "zod";
import type { ExecutionContext } from "@cloudflare/workers-types";

/**
 * Zod schema for AuthCtx
 * Note: authMethod and ip are optional in the schema to support legacy persisted grants,
 * but the type-level contract requires them (filled in by extractAuth with defaults).
 */
const AuthCtxSchema = z.object({
  userId: z.string(),
  scopes: z.array(z.string()),
  authMethod: z.enum(["oauth", "api_token", "admin_token", "oidc", "none"]).optional(),
  ip: z.string().optional(),
  tokenId: z.string().optional(),
});

export type AuthMethod = "oauth" | "api_token" | "admin_token" | "oidc" | "none";

/**
 * AuthCtx type with required authMethod and ip at the type level.
 * The schema allows them to be optional to support legacy grants,
 * but extractAuth fills in defaults so runtime objects always have them.
 */
export type AuthCtx = {
  userId: string;
  scopes: string[];
  authMethod: AuthMethod;
  ip: string;
  tokenId?: string;
};

/**
 * Anonymous user constant
 */
export const ANONYMOUS: AuthCtx = {
  userId: "anonymous",
  scopes: [],
  authMethod: "none",
  ip: "unknown",
};

/**
 * Extract AuthCtx from ExecutionContext.props
 * Fail-closed: malformed/missing → ANONYMOUS (C1)
 * For legacy grants without authMethod/ip, fills in defaults (C1 migration path).
 *
 * @param ctx - Cloudflare Workers ExecutionContext
 * @returns AuthCtx object (always has authMethod and ip set)
 */
export function extractAuth(ctx: ExecutionContext): AuthCtx {
  try {
    // ExecutionContext.props may be null/undefined or malformed
    if (!ctx.props || typeof ctx.props !== "object") {
      return ANONYMOUS;
    }

    const parsed = AuthCtxSchema.safeParse(ctx.props);
    if (!parsed.success) {
      return ANONYMOUS;
    }

    // Fill in defaults for optional fields for backward compatibility
    const data = parsed.data;
    return {
      userId: data.userId,
      scopes: data.scopes,
      authMethod: data.authMethod ?? "oauth",
      ip: data.ip ?? "unknown",
      ...(data.tokenId ? { tokenId: data.tokenId } : {}),
    };
  } catch {
    // Any unexpected error → anonymous (fail-closed)
    return ANONYMOUS;
  }
}

/**
 * Enrich AuthCtx with HTTP edge metadata (ip and authMethod).
 * Keep tokenId from the original ctx if present.
 *
 * @param auth - Original AuthCtx (may have defaults from extractAuth)
 * @param request - Incoming HTTP Request
 * @param authMethod - Auth method to set (from request or explicit)
 * @param tokenId - Optional tokenId to set
 * @returns Enriched AuthCtx with ip from CF-Connecting-IP header
 */
export function enrichAuthFromRequest(
  auth: AuthCtx,
  request: Request,
  authMethod: AuthMethod,
  tokenId?: string
): AuthCtx {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  return {
    ...auth,
    ip,
    authMethod,
    ...(tokenId !== undefined ? { tokenId } : {}),
  };
}
