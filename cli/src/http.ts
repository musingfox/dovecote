import { CliError, ExitCode } from "./exit-codes.ts";
import {
  type CliConfig,
  type ActiveToken,
  writeConfig,
  resolveActiveToken,
} from "./config.ts";

export interface RequestOptions {
  method?: string;
  path: string;
  body?: unknown;
  /** Override default 30s timeout in ms. */
  timeoutMs?: number;
  /** Set Authorization header explicitly (used by exchange call with OAuth bearer). */
  authHeader?: string;
  /** When true, skip bearer auto-attach + auto-renew. Used for /health, /token, /authorize. */
  noAuth?: boolean;
  /** Extra headers to merge in. */
  headers?: Record<string, string>;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  body: string;
  json: <T = unknown>() => T;
}

/**
 * Auto-renew threshold: 14 days in milliseconds.
 */
export const AUTO_RENEW_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Default request timeout. Per plan D-G.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface HttpClientDeps {
  /** Server base URL (no trailing slash). */
  serverUrl: string;
  /** Current config (read-only snapshot). */
  config: CliConfig | null;
  /** Where to write the updated config after a successful auto-renew. */
  configPath?: string;
  /** Environment variables (for DOVECOTE_TOKEN resolution). */
  env?: NodeJS.ProcessEnv;
  /** Override fetch (for tests). */
  fetchImpl?: typeof fetch;
  /** Override Date.now (for tests). */
  now?: () => number;
}

/**
 * Build a CLI HTTP client. Each request:
 *   1. If config-sourced token AND expiresAt - now < threshold → try renew once
 *      (failures are swallowed; original request still fires).
 *   2. Attaches `Authorization: Bearer <token>` (unless noAuth or authHeader override).
 *   3. AbortController for timeoutMs (default 30s).
 *   4. Maps 401 expired_token → CliError(ExitCode.TOKEN_EXPIRED).
 */
export function createHttpClient(deps: HttpClientDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  let currentConfig: CliConfig | null = deps.config;

  async function request(opts: RequestOptions): Promise<HttpResponse> {
    // Auto-renew step (only for config-sourced tokens, not env-sourced).
    if (!opts.noAuth && !opts.authHeader) {
      await maybeAutoRenew();
    }

    const active: ActiveToken | null = opts.noAuth
      ? null
      : resolveActiveToken(currentConfig, deps.env ?? process.env);

    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(opts.headers ?? {}),
    };
    if (opts.authHeader) {
      headers["Authorization"] = opts.authHeader;
    } else if (active && !opts.noAuth) {
      headers["Authorization"] = `Bearer ${active.token}`;
    }

    const ctrl = new AbortController();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(`${deps.serverUrl}${opts.path}`, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: ctrl.signal,
      });
    } catch (e: any) {
      clearTimeout(timer);
      if (e && (e.name === "AbortError" || ctrl.signal.aborted)) {
        throw new CliError(
          ExitCode.UPSTREAM,
          `Request timed out after ${timeoutMs}ms: ${opts.path}`
        );
      }
      throw new CliError(
        ExitCode.UPSTREAM,
        `Network error: ${e?.message ?? e}`
      );
    }
    clearTimeout(timer);

    const body = await res.text();
    const response: HttpResponse = {
      status: res.status,
      headers: res.headers,
      body,
      json: <T = unknown>() => JSON.parse(body) as T,
    };

    // 401 expired_token → exit 9 with source-aware message.
    if (res.status === 401) {
      try {
        const parsed = JSON.parse(body) as any;
        if (parsed?.error_description === "expired_token") {
          if (active?.source === "env") {
            throw new CliError(
              ExitCode.TOKEN_EXPIRED,
              "Token from DOVECOTE_TOKEN has expired; rotate the value or run `dovecote auth login`"
            );
          }
          throw new CliError(
            ExitCode.TOKEN_EXPIRED,
            "Session expired; run `dovecote auth login`"
          );
        }
      } catch (e) {
        if (e instanceof CliError) throw e;
        // Not JSON or unrelated 401 — fall through and return response.
      }
    }

    return response;
  }

  async function maybeAutoRenew(): Promise<void> {
    const active = resolveActiveToken(currentConfig, deps.env ?? process.env);
    if (!active) return;
    if (active.source !== "config") return;
    if (active.expiresAt === undefined || active.tokenId === undefined) return;
    const remaining = active.expiresAt - now();
    if (remaining >= AUTO_RENEW_THRESHOLD_MS) return;

    try {
      const renewCtrl = new AbortController();
      const renewTimer = setTimeout(() => renewCtrl.abort(), 30_000);
      const res = await fetchImpl(
        `${deps.serverUrl}/v1/tokens/${active.tokenId}/renew`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${active.token}`,
            Accept: "application/json",
          },
          signal: renewCtrl.signal,
        }
      );
      clearTimeout(renewTimer);
      if (!res.ok) return; // swallow non-2xx
      const text = await res.text();
      const parsed = JSON.parse(text) as {
        token: string;
        tokenId: string;
        userId?: string;
        scopes: string[];
        expiresAt: number;
        label?: string;
      };
      // Rewrite config: replace tokens[0] with the new one.
      if (currentConfig) {
        const newToken = {
          tokenId: parsed.tokenId,
          token: parsed.token,
          userId: parsed.userId ?? active.userId ?? "",
          scopes: parsed.scopes,
          expiresAt: parsed.expiresAt,
          ...(parsed.label ? { label: parsed.label } : {}),
        };
        currentConfig = {
          ...currentConfig,
          tokens: [newToken],
        };
        try {
          await writeConfig(currentConfig, deps.configPath);
        } catch {
          // Config write failure shouldn't abort the main request.
        }
      }
    } catch {
      // Renew network/5xx failure swallowed — original request proceeds.
    }
  }

  return {
    request,
    /** Test/inspection: returns the live in-memory config snapshot. */
    getConfig: () => currentConfig,
  };
}
