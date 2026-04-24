import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { Env } from "../types.js";
import type { AuthCtx } from "../auth/ctx.js";
import { readEnvProfile } from "../storage/env-store.js";
import { writeAudit } from "../auth/audit.js";

export function registerGetEnvTool(
  server: McpServer,
  env: Env,
  auth: AuthCtx,
  ctx: ExecutionContext
): void {
  // @ts-expect-error - zod peer dependency type conflict with MCP SDK
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
      // Check scope authorization
      if (!auth.scopes.includes("dovecote:env:read")) {
        writeAudit(env, ctx, {
          event: "env.read",
          userId: auth.userId,
          profile,
          ok: false,
        });

        return {
          content: [
            {
              type: "text",
              text: "Forbidden: missing scope dovecote:env:read",
            },
          ],
          isError: true,
        };
      }

      // Read from KV
      let value: string | null;
      try {
        value = await readEnvProfile(env.OAUTH_KV, profile);
      } catch (error) {
        writeAudit(env, ctx, {
          event: "env.read",
          userId: auth.userId,
          profile,
          ok: false,
        });
        throw error;
      }

      if (value === null) {
        writeAudit(env, ctx, {
          event: "env.read",
          userId: auth.userId,
          profile,
          ok: false,
        });

        return {
          content: [
            {
              type: "text",
              text: `Profile "${profile}" not found`,
            },
          ],
          isError: true,
        };
      }

      // Success
      writeAudit(env, ctx, {
        event: "env.read",
        userId: auth.userId,
        profile,
        ok: true,
      });

      return {
        content: [
          {
            type: "text",
            text: value,
          },
        ],
      };
    }
  );
}
