import { createServer, type Server } from "node:http";
import { CliError, ExitCode } from "./exit-codes.ts";
import {
  generateCodeVerifier,
  generateCodeChallenge,
  isLoopbackRedirect,
} from "./pkce.ts";

export type Browser = (url: string) => Promise<void>;

export interface LoopbackResult {
  code: string;
  state: string;
}

/**
 * A loopback server that listens for the OAuth redirect callback.
 *
 * Inversion of control: tests inject a fake server that resolves immediately
 * with a {code, state} pair. Production uses the node:http impl below.
 */
export interface LoopbackServer {
  /** The redirect_uri to register with OAuth (e.g., "http://127.0.0.1:53017"). */
  redirectUri: string;
  /** Resolve when the OAuth provider hits the loopback. Rejects on timeout. */
  waitForCallback(timeoutMs: number): Promise<LoopbackResult>;
  /** Stop listening. */
  close(): Promise<void>;
  /**
   * (Test hook) The auth-flow calls this with the constructed authorize URL
   * BEFORE waitForCallback. Real impl can ignore; fake impls may use it to
   * read `state` and echo it back from waitForCallback.
   */
  onAuthorizeUrl?(url: string): void;
}

export type LoopbackServerFactory = () => Promise<LoopbackServer>;

/**
 * Default loopback server: binds to 127.0.0.1:0 (random port), returns the
 * code/state from the first request. Validates that the redirect URI matches
 * the dovecote regex.
 */
export const defaultLoopbackFactory: LoopbackServerFactory = async () => {
  const server: Server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    server.close();
    throw new CliError(
      ExitCode.OAUTH_FAILED,
      "Loopback server returned no address"
    );
  }
  const redirectUri = `http://127.0.0.1:${addr.port}`;
  if (!isLoopbackRedirect(redirectUri)) {
    server.close();
    throw new CliError(
      ExitCode.OAUTH_FAILED,
      `Generated redirect_uri does not match loopback regex: ${redirectUri}`
    );
  }

  return {
    redirectUri,
    waitForCallback(timeoutMs: number) {
      return new Promise<LoopbackResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          server.close();
          reject(
            new CliError(
              ExitCode.OAUTH_FAILED,
              `OAuth callback timeout after ${timeoutMs}ms`
            )
          );
        }, timeoutMs);
        server.on("request", (req, res) => {
          try {
            const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
            const code = url.searchParams.get("code");
            const state = url.searchParams.get("state");
            res.statusCode = 200;
            res.setHeader("Content-Type", "text/plain");
            res.end(code ? "Login complete. You may close this window." : "missing code");
            if (code && state) {
              clearTimeout(timer);
              resolve({ code, state });
            }
          } catch (e) {
            res.statusCode = 500;
            res.end("err");
            clearTimeout(timer);
            reject(e);
          }
        });
      });
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

export interface PerformLoopbackArgs {
  serverUrl: string;
  clientId: string;
  scopes: string[];
  noBrowser: boolean;
  browser?: Browser;
  loopbackFactory?: LoopbackServerFactory;
  stderr: (s: string) => void;
  fetchImpl?: typeof fetch;
  /** Override timeouts for tests (ms). */
  callbackTimeoutMs?: number;
}

/**
 * End-to-end PKCE loopback authorization. Returns the OAuth access_token on
 * success. Throws CliError with the appropriate exit code on failure.
 */
export async function performLoopbackAuthorize(
  args: PerformLoopbackArgs
): Promise<string> {
  const factory = args.loopbackFactory ?? defaultLoopbackFactory;
  const fetchImpl = args.fetchImpl ?? fetch;
  const server = await factory();
  try {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const state = generateCodeVerifier(); // reuse random-string helper

    const authorizeUrl = new URL(`${args.serverUrl}/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", args.clientId);
    authorizeUrl.searchParams.set("redirect_uri", server.redirectUri);
    authorizeUrl.searchParams.set("scope", args.scopes.join(" "));
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    // Notify the loopback server with the authorize URL (test hook).
    if (server.onAuthorizeUrl) {
      try {
        server.onAuthorizeUrl(authorizeUrl.toString());
      } catch {
        // ignore
      }
    }

    if (args.noBrowser) {
      args.stderr(`Open this URL to authorize:\n${authorizeUrl.toString()}\n`);
    } else if (args.browser) {
      args.stderr(`Opening browser to ${authorizeUrl.toString()}\n`);
      try {
        await args.browser(authorizeUrl.toString());
      } catch {
        args.stderr(
          `Failed to open browser; copy the URL above into your browser.\n`
        );
      }
    } else {
      args.stderr(`Open this URL to authorize:\n${authorizeUrl.toString()}\n`);
    }

    const timeoutMs = args.callbackTimeoutMs ?? 120_000;
    const cb = await server.waitForCallback(timeoutMs);
    if (cb.state !== state) {
      throw new CliError(
        ExitCode.OAUTH_FAILED,
        "OAuth state mismatch — possible CSRF or session crossover"
      );
    }

    // Exchange code for access_token via the OAuth token endpoint
    const form = new URLSearchParams();
    form.set("grant_type", "authorization_code");
    form.set("code", cb.code);
    form.set("redirect_uri", server.redirectUri);
    form.set("client_id", args.clientId);
    form.set("code_verifier", codeVerifier);

    const tokenRes = await fetchImpl(`${args.serverUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      throw new CliError(
        ExitCode.OAUTH_FAILED,
        `Token endpoint returned ${tokenRes.status}: ${text}`
      );
    }
    const tokenJson = (await tokenRes.json()) as { access_token?: string };
    if (!tokenJson.access_token) {
      throw new CliError(
        ExitCode.OAUTH_FAILED,
        "Token endpoint did not return access_token"
      );
    }
    return tokenJson.access_token;
  } finally {
    await server.close();
  }
}

export interface ExchangeArgs {
  serverUrl: string;
  oauthToken: string;
  label?: string;
  expiresIn?: "7d" | "30d" | "60d" | "90d";
  fetchImpl?: typeof fetch;
}

/**
 * POST /v1/auth/exchange — trade OAuth bearer for a `dvct_*` token.
 */
export async function exchangeOAuthForRuntimeToken(args: ExchangeArgs): Promise<{
  token: string;
  tokenId: string;
  userId: string;
  scopes: string[];
  expiresAt: number;
  label?: string;
}> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const body: Record<string, unknown> = {};
  if (args.label) body.label = args.label;
  if (args.expiresIn) body.expiresIn = args.expiresIn;
  const res = await fetchImpl(`${args.serverUrl}/v1/auth/exchange`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.oauthToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (res.status === 403) {
    throw new CliError(
      ExitCode.FORBIDDEN,
      "Admin scope not granted at authorization step"
    );
  }
  if (res.status >= 500) {
    throw new CliError(
      ExitCode.UPSTREAM,
      `Exchange endpoint returned ${res.status}`
    );
  }
  if (!res.ok) {
    const text = await res.text();
    throw new CliError(
      ExitCode.GENERIC,
      `Exchange failed: ${res.status} ${text}`
    );
  }
  return (await res.json()) as any;
}
