import type { MiddlewareHandler } from "hono";
import type { Env } from "../types.js";
import { verifyToken } from "./api-token.js";
import type { AuthCtx } from "./ctx.js";
import { writeAudit } from "./audit.js";

/**
 * Bearer middleware: validates `Authorization: Bearer dvct_<token>` against KV.
 *
 * On success: sets `c.set("auth", AuthCtx)` (with IP enrichment) and calls next().
 * On failure: returns 401 with one of {missing_authorization, malformed_bearer,
 * invalid_token, expired_token} as `error_description`, and emits a `token.use`
 * audit event with `ok:false` and a corresponding `reason`.
 */
export const bearerMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: { auth: AuthCtx };
}> = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";

  // No Authorization header
  if (!authHeader) {
    writeAudit(c.env, c.executionCtx, {
      event: "token.use",
      ok: false,
      reason: "missing_authorization",
      authMethod: "api_token",
      ip,
      scope: "dovecote:notify",
    });
    return c.json(
      {
        error: "unauthorized",
        error_description: "missing_authorization",
      },
      401
    );
  }

  // Check Bearer dvct_ prefix
  if (!authHeader.startsWith("Bearer dvct_")) {
    writeAudit(c.env, c.executionCtx, {
      event: "token.use",
      ok: false,
      reason: "malformed_bearer",
      authMethod: "api_token",
      ip,
      scope: "dovecote:notify",
    });
    return c.json(
      {
        error: "unauthorized",
        error_description: "malformed_bearer",
      },
      401
    );
  }

  const token = authHeader.substring(7); // Remove "Bearer "

  // Verify token. Infra errors (KV read failure) are re-thrown as KVWriteError
  // and propagate to Hono's error handler → 500.
  const outcome = await verifyToken(token, c.env, Date.now());

  switch (outcome.kind) {
    case "invalid": {
      writeAudit(c.env, c.executionCtx, {
        event: "token.use",
        ok: false,
        reason: "invalid_token",
        authMethod: "api_token",
        ip,
        scope: "dovecote:notify",
      });
      return c.json(
        {
          error: "unauthorized",
          error_description: "invalid_token",
        },
        401
      );
    }
    case "expired": {
      writeAudit(c.env, c.executionCtx, {
        event: "token.use",
        ok: false,
        reason: "expired",
        tokenId: outcome.tokenId,
        userId: outcome.userId,
        authMethod: "api_token",
        ip,
        scope: outcome.scopes.join(" "),
      });
      return c.json(
        {
          error: "unauthorized",
          error_description: "expired_token",
        },
        401
      );
    }
    case "valid": {
      const authCtx: AuthCtx = {
        ...outcome.auth,
        ip,
      };
      c.set("auth", authCtx);

      const route = c.req.path.split("?")[0] ?? c.req.path;
      writeAudit(c.env, c.executionCtx, {
        event: "token.use",
        ok: true,
        tokenId: authCtx.tokenId,
        userId: authCtx.userId,
        authMethod: "api_token",
        ip,
        scope: authCtx.scopes.join(" "),
        route,
      });

      await next();
      return;
    }
  }
};
