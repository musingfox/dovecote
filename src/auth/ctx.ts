import { z } from "zod";
import type { ExecutionContext } from "@cloudflare/workers-types";

/**
 * Zod schema for AuthCtx
 * Note: NOT using .strict() to accept legacy:{true} + userId + scopes (C4)
 */
const AuthCtxSchema = z.object({
  userId: z.string(),
  scopes: z.array(z.string()),
});

export type AuthCtx = z.infer<typeof AuthCtxSchema>;

/**
 * Anonymous user constant
 */
export const ANONYMOUS: AuthCtx = {
  userId: "anonymous",
  scopes: [],
};

/**
 * Extract AuthCtx from ExecutionContext.props
 * Fail-closed: malformed/missing → ANONYMOUS (C1)
 *
 * @param ctx - Cloudflare Workers ExecutionContext
 * @returns AuthCtx object
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

    return parsed.data;
  } catch {
    // Any unexpected error → anonymous (fail-closed)
    return ANONYMOUS;
  }
}
