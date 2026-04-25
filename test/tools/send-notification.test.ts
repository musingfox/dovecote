import { describe, it, expect, mock } from "bun:test";
import { registerSendNotificationTool } from "../../src/tools/send-notification.js";
import type { Env } from "../../src/types.js";
import type { AuthCtx } from "../../src/auth/ctx.js";
import { createMockExecutionCtx } from "../helpers/mock-execution-ctx.js";
import { MockKV } from "../helpers/mock-kv.js";

describe("send-notification tool registration", () => {
  function setupMockServer() {
    let capturedName: string | undefined;
    let capturedDescription: string | undefined;
    let capturedSchema: any;

    const mockServer = {
      tool: mock((name: string, description: string, schema: any, _handler: any) => {
        capturedName = name;
        capturedDescription = description;
        capturedSchema = schema;
      }),
    };

    const kv = new MockKV();
    const env: Env = {
      OAUTH_KV: kv as any,
      OAUTH_PASSWORD: "test",
      COOKIE_ENCRYPTION_KEY: "test",
    };
    const auth: AuthCtx = { userId: "user-1", scopes: ["dovecote:notify"] };
    const ctx = createMockExecutionCtx(auth) as any;

    registerSendNotificationTool(mockServer as any, env, auth, ctx);

    return { capturedName, capturedDescription, capturedSchema };
  }

  it('tool description contains "embed" (case-insensitive)', () => {
    const { capturedDescription } = setupMockServer();
    expect(capturedDescription).toBeDefined();
    expect(capturedDescription!.toLowerCase()).toContain("embed");
  });

  it('content param description contains "text"', () => {
    const { capturedSchema } = setupMockServer();
    const contentDescription: string = capturedSchema.content.description ?? "";
    expect(contentDescription.toLowerCase()).toContain("text");
  });

  it('content param description contains "embed"', () => {
    const { capturedSchema } = setupMockServer();
    const contentDescription: string = capturedSchema.content.description ?? "";
    expect(contentDescription.toLowerCase()).toContain("embed");
  });
});
