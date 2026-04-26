/**
 * CSRF token generation and validation using HMAC-SHA256
 * Cookie format: <nonce>.<base64_hmac(nonce)>
 */

const COOKIE_NAME = "csrf";

/**
 * Generate a CSRF token and cookie
 */
export async function generateCSRF({ secretKey }: { secretKey: string }): Promise<{
  token: string;
  cookie: string;
}> {
  const nonce = crypto.randomUUID();
  const hmac = await computeHMAC(nonce, secretKey);
  const cookieValue = `${nonce}.${hmac}`;

  const cookie = `${COOKIE_NAME}=${cookieValue}; HttpOnly; Secure; Path=/; SameSite=Lax`;

  return {
    token: nonce,
    cookie,
  };
}

/**
 * Validate CSRF token against cookie
 */
export async function validateCSRF({
  request,
  secretKey,
}: {
  request: Request;
  secretKey: string;
}): Promise<boolean> {
  try {
    // Extract CSRF token from form data
    const formData = await request.clone().formData();
    const token = formData.get("csrf_token");
    if (!token || typeof token !== "string") {
      return false;
    }

    // Extract cookie value
    const cookieHeader = request.headers.get("Cookie");
    if (!cookieHeader) {
      return false;
    }

    const cookieValue = parseCookie(cookieHeader, COOKIE_NAME);
    if (!cookieValue) {
      return false;
    }

    // Parse cookie value
    const parts = cookieValue.split(".");
    if (parts.length !== 2) {
      return false;
    }

    const [nonce, expectedHmac] = parts as [string, string];

    // Verify nonce matches token (timing-safe)
    if (!timingSafeEqual(nonce, token)) {
      return false;
    }

    // Verify HMAC
    const actualHmac = await computeHMAC(nonce, secretKey);
    return timingSafeEqual(expectedHmac, actualHmac);
  } catch {
    return false;
  }
}

/**
 * Compute HMAC-SHA256 and return base64-encoded result
 */
async function computeHMAC(data: string, secretKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return base64url(new Uint8Array(signature));
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Parse a specific cookie from the Cookie header
 */
function parseCookie(cookieHeader: string, name: string): string | null {
  const cookies = cookieHeader.split(";").map((c) => c.trim());
  for (const cookie of cookies) {
    const [cookieName, ...valueParts] = cookie.split("=");
    if (cookieName === name) {
      return valueParts.join("=");
    }
  }
  return null;
}

/**
 * Timing-safe string comparison
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}
