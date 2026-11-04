import type { MiddlewareHandler } from "hono";

/**
 * The Client ID Metadata Documents dovecote accepts as client_ids. The provider
 * fetches any https URL client_id it is handed, so every other URL is refused
 * before the provider sees the request and never causes an outbound fetch.
 */
export const CIMD_CLIENT_IDS: ReadonlySet<string> = new Set([
  "https://claude.ai/oauth/mcp-oauth-client-metadata",
  "https://claude.ai/oauth/claude-code-client-metadata",
]);

// Same WHATWG parser the provider uses, so a client_id it would read as a URL
// (leading spaces, mixed-case scheme) is read as one here too.
function isRefusedClientId(clientId: string): boolean {
  if (CIMD_CLIENT_IDS.has(clientId)) return false;
  try {
    const { protocol } = new URL(clientId);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

// A body that is not a form leaves nothing to check; the provider refuses it.
async function readForm(request: Request): Promise<URLSearchParams> {
  const fields = new URLSearchParams();
  try {
    const form = await request.clone().formData();
    form.forEach((value, name) => {
      if (typeof value === "string") fields.append(name, value);
    });
  } catch {}
  return fields;
}

type BasicClientId = { kind: "not-basic" } | { kind: "malformed" } | { kind: "id"; clientId: string };

// A copy of the provider's RFC 6749 Basic parsing (parseBasicAuthorizationHeader),
// step for step: any divergence lets a header past this guard that the provider
// still reads as a URL client_id. A malformed Basic header is refused here,
// as the provider refuses it.
function basicClientId(header: string | undefined): BasicClientId {
  if (!header) return { kind: "not-basic" };
  const schemeEnd = header.search(/[ \t]/);
  if ((schemeEnd === -1 ? header : header.slice(0, schemeEnd)).toLowerCase() !== "basic") {
    return { kind: "not-basic" };
  }
  if (schemeEnd === -1) return { kind: "malformed" };
  const encoded = header.slice(schemeEnd).trim();
  if (!encoded || /[ \t]/.test(encoded)) return { kind: "malformed" };
  try {
    const credentials = atob(encoded);
    const separator = credentials.indexOf(":");
    if (separator === -1) return { kind: "malformed" };
    return { kind: "id", clientId: decodeURIComponent(credentials.slice(0, separator).replace(/\+/g, " ")) };
  } catch {
    return { kind: "malformed" };
  }
}

/** Refuses an /authorize request whose client_id is a URL outside the allowlist. */
export const guardAuthorizeClientId: MiddlewareHandler = async (c, next) => {
  const ids = new URL(c.req.url).searchParams.getAll("client_id");
  if (c.req.method === "POST") ids.push(...(await readForm(c.req.raw)).getAll("client_id"));
  if (ids.some(isRefusedClientId)) {
    return c.json(
      { error: "invalid_client", error_description: "client_id is not an accepted client metadata document URL" },
      400,
    );
  }
  return next();
};

/**
 * Refuses a /token request (token exchange or revocation) that names a URL
 * client_id outside the allowlist in the body or Basic header, or that sends a
 * client assertion: the provider reads an assertion's unverified iss as the
 * client_id, and no client dovecote accepts authenticates with one.
 */
export const guardTokenClientId: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== "POST") return next();
  const form = await readForm(c.req.raw);
  const ids = form.getAll("client_id");
  const basic = basicClientId(c.req.header("Authorization"));
  if (basic.kind === "id") ids.push(basic.clientId);
  const assertion = form.has("client_assertion") || form.has("client_assertion_type");
  if (basic.kind === "malformed" || assertion || ids.some(isRefusedClientId)) {
    const challenge = basic.kind === "not-basic" ? undefined : { "WWW-Authenticate": 'Basic realm="OAuth"' };
    return c.json({ error: "invalid_client", error_description: "Client authentication failed" }, 401, challenge);
  }
  return next();
};
