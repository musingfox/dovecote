import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { Env } from "../types.js";
import type { AuthCtx } from "../auth/ctx.js";
import { readEnvProfile } from "../storage/env-store.js";

export function registerGetEnvTool(
  server: McpServer,
  env: Env,
  auth: AuthCtx,
  _ctx: ExecutionContext
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
        const auditLog = {
          event: "env.read",
          userId: auth.userId,
          profile,
          ok: false,
          ts: Date.now(),
        };
        console.log(JSON.stringify(auditLog));

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
        console.log(
          JSON.stringify({
            event: "env.read",
            userId: auth.userId,
            profile,
            ok: false,
            ts: Date.now(),
          })
        );
        throw error;
      }

      if (value === null) {
        const auditLog = {
          event: "env.read",
          userId: auth.userId,
          profile,
          ok: false,
          ts: Date.now(),
        };
        console.log(JSON.stringify(auditLog));

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
      const auditLog = {
        event: "env.read",
        userId: auth.userId,
        profile,
        ok: true,
        ts: Date.now(),
      };
      console.log(JSON.stringify(auditLog));

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
