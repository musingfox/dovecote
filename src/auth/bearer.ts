import { MiddlewareHandler } from "hono";
import type { Env } from "../types.js";

export const bearerMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c) => {
  return c.json(
    {
      error: "unauthorized",
      error_description: "bearer middleware not yet implemented",
    },
    401,
  );
};
