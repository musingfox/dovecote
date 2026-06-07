/**
 * Regression tests for scripts/oidc-exchange.sh
 *
 * Covers:
 *   A-1: OIDC mode success — DOVECOTE_TOKEN=dvct_* written to GITHUB_ENV
 *   A-3: Dovecote server non-2xx (403) → non-zero exit, no DOVECOTE_TOKEN written
 *   A-4: Legacy mode (MODE=legacy + INPUT_TOKEN) → token written, zero HTTP calls to dovecote
 *   A-5: OIDC mode missing DOVECOTE_SERVER_URL → non-zero exit, stderr contains "server-url" or "DOVECOTE_SERVER_URL"
 */

import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "/Users/nickhuang/workspace/dovecote";
const SCRIPT = `${REPO}/scripts/oidc-exchange.sh`;

// ---------------------------------------------------------------------------
// Helper: spawn the script with given env, return exit code + streams + GITHUB_ENV contents
// ---------------------------------------------------------------------------
async function runScript(
  envOverrides: Record<string, string>,
  githubEnvFile: string,
): Promise<{ exitCode: number; stdout: string; stderr: string; githubEnvContent: string }> {
  const proc = Bun.spawn(["bash", SCRIPT], {
    env: {
      ...process.env,
      GITHUB_ENV: githubEnvFile,
      // Clear mode-detection vars unless overridden
      MODE: "",
      INPUT_TOKEN: "",
      ...envOverrides,
    },
    stdout: "pipe",
    stderr: "pipe",
    cwd: REPO,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  let githubEnvContent = "";
  try {
    githubEnvContent = readFileSync(githubEnvFile, "utf8");
  } catch {
    githubEnvContent = "";
  }
  return { exitCode, stdout, stderr, githubEnvContent };
}

// ---------------------------------------------------------------------------
// A-1: OIDC mode success
// ---------------------------------------------------------------------------
test("A-1: OIDC success — DOVECOTE_TOKEN=dvct_* written to GITHUB_ENV", async () => {
  const dvct_token = "dvct_regtest_success_001";

  // Start mock OIDC endpoint: returns {"value":"<jwt>"}
  const oidcServer = Bun.serve({
    port: 0,
    fetch() {
      return new Response(JSON.stringify({ value: "eyJ.mock.jwt" }), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  // Start mock dovecote server: returns token on POST /v1/auth/github-oidc
  const dovecoteServer = Bun.serve({
    port: 0,
    fetch(req) {
      if (req.url.includes("/v1/auth/github-oidc")) {
        return new Response(
          JSON.stringify({ token: dvct_token, scopes: ["dovecote:notify"], expiresAt: 9999999999 }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });

  const tmpDir = mkdtempSync(join(tmpdir(), "oidc-a1-"));
  const githubEnvFile = join(tmpDir, "GITHUB_ENV");
  writeFileSync(githubEnvFile, "");

  try {
    const { exitCode, githubEnvContent } = await runScript(
      {
        ACTIONS_ID_TOKEN_REQUEST_URL: `http://localhost:${oidcServer.port}/token`,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "mock-bearer",
        DOVECOTE_SERVER_URL: `http://localhost:${dovecoteServer.port}`,
        OIDC_AUDIENCE: "https://dovecote.example.com",
        MODE: "oidc",
      },
      githubEnvFile,
    );

    expect(exitCode).toBe(0);
    expect(githubEnvContent).toMatch(/^DOVECOTE_TOKEN=dvct_/m);
    expect(githubEnvContent).toContain(`DOVECOTE_TOKEN=${dvct_token}`);
  } finally {
    oidcServer.stop();
    dovecoteServer.stop();
    rmSync(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// A-3: Dovecote returns 403 → non-zero exit, no DOVECOTE_TOKEN written
// ---------------------------------------------------------------------------
test("A-3: dovecote 403 → non-zero exit, no DOVECOTE_TOKEN in GITHUB_ENV", async () => {
  const oidcServer = Bun.serve({
    port: 0,
    fetch() {
      return new Response(JSON.stringify({ value: "eyJ.mock.jwt" }), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  const dovecote403 = Bun.serve({
    port: 0,
    fetch(req) {
      if (req.url.includes("/v1/auth/github-oidc")) {
        return new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const tmpDir = mkdtempSync(join(tmpdir(), "oidc-a3-"));
  const githubEnvFile = join(tmpDir, "GITHUB_ENV");
  writeFileSync(githubEnvFile, "");

  try {
    const { exitCode, githubEnvContent } = await runScript(
      {
        ACTIONS_ID_TOKEN_REQUEST_URL: `http://localhost:${oidcServer.port}/token`,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "mock-bearer",
        DOVECOTE_SERVER_URL: `http://localhost:${dovecote403.port}`,
        OIDC_AUDIENCE: "https://dovecote.example.com",
        MODE: "oidc",
      },
      githubEnvFile,
    );

    expect(exitCode).not.toBe(0);
    expect(githubEnvContent).not.toMatch(/^DOVECOTE_TOKEN=/m);
  } finally {
    oidcServer.stop();
    dovecote403.stop();
    rmSync(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// A-4: Legacy mode — INPUT_TOKEN written directly, zero HTTP to dovecote
// ---------------------------------------------------------------------------
test("A-4: legacy mode — DOVECOTE_TOKEN from INPUT_TOKEN, zero HTTP to dovecote", async () => {
  let dovecoteCallCount = 0;
  const dovecoteServer = Bun.serve({
    port: 0,
    fetch(req) {
      if (req.url.includes("/v1/auth/github-oidc")) {
        dovecoteCallCount++;
      }
      return new Response("{}", { status: 200 });
    },
  });

  const tmpDir = mkdtempSync(join(tmpdir(), "oidc-a4-"));
  const githubEnvFile = join(tmpDir, "GITHUB_ENV");
  writeFileSync(githubEnvFile, "");

  try {
    const { exitCode, githubEnvContent } = await runScript(
      {
        MODE: "legacy",
        INPUT_TOKEN: "dvct_legacy_committed_test",
        DOVECOTE_SERVER_URL: `http://localhost:${dovecoteServer.port}`,
        OIDC_AUDIENCE: "https://dovecote.example.com",
        // ACTIONS_ID_TOKEN_REQUEST_URL intentionally omitted
      },
      githubEnvFile,
    );

    expect(exitCode).toBe(0);
    expect(githubEnvContent).toContain("DOVECOTE_TOKEN=dvct_legacy_committed_test");
    expect(dovecoteCallCount).toBe(0);
  } finally {
    dovecoteServer.stop();
    rmSync(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// A-5: OIDC mode missing DOVECOTE_SERVER_URL → non-zero exit, stderr message
// ---------------------------------------------------------------------------
test("A-5: missing DOVECOTE_SERVER_URL → non-zero exit, stderr contains server-url/DOVECOTE_SERVER_URL", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "oidc-a5-"));
  const githubEnvFile = join(tmpDir, "GITHUB_ENV");
  writeFileSync(githubEnvFile, "");

  try {
    const { exitCode, stderr } = await runScript(
      {
        // DOVECOTE_SERVER_URL intentionally absent
        ACTIONS_ID_TOKEN_REQUEST_URL: "http://localhost:9/token",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "mock-bearer",
        OIDC_AUDIENCE: "https://dovecote.example.com",
        MODE: "oidc",
      },
      githubEnvFile,
    );

    expect(exitCode).not.toBe(0);
    expect(stderr.toLowerCase()).toMatch(/server-url|dovecote_server_url/i);
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});
