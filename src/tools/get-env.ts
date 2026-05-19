import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { Env } from "../types.js";
import type { AuthCtx } from "../auth/ctx.js";
import { readEnv } from "../services/env.js";
import { ScopeError, NotFoundError, UpstreamError } from "../services/errors.js";

export function registerGetEnvTool(
  server: McpServer,
  env: Env,
  auth: AuthCtx,
  ctx: ExecutionContext
): void {
  server.tool(
    "get_env",
    "Read environment profile from KV storage (requires dovecote:env:read scope)",
    {
      profile: z
        .string()
        .min(1)
        .regex(/^[a-zA-Z0-9_-]+$/, "Profile must match /^[a-zA-Z0-9_-]+$/")
        .describe("Environment profile name"),
    },
    async ({ profile }) => {
      try {
        const value = await readEnv(env, auth, ctx, { profile });
        return {
          content: [
            {
              type: "text",
              text: value,
            },
          ],
        };
      } catch (err) {
        if (err instanceof ScopeError) {
          return {
            content: [
              {
                type: "text",
                text: `Forbidden: missing scope ${err.requiredScope}`,
              },
            ],
            isError: true,
          };
        }
        if (err instanceof NotFoundError) {
          return {
            content: [
              {
                type: "text",
                text: err.message,
              },
            ],
            isError: true,
          };
        }
        if (err instanceof UpstreamError) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to read profile ${profile}: ${err.message}`,
              },
            ],
            isError: true,
          };
        }
        throw err;
      }
    }
  );
}
