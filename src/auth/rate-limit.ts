import type { KVNamespace } from "@cloudflare/workers-types";

export interface RateLimitResult {
  allowed: boolean;
  current: number;
}

/**
 * Check rate limit for endpoints (Contract A, extended for RateLimit-Namespace)
 * - configurable requests per 60 seconds per IP
 * - Fail-open on KV errors (don't block on infrastructure issues)
 *
 * @param kv - KVNamespace for storing counters
 * @param ip - Client IP address
 * @param namespace - Rate limit namespace (default: "revoke" for backward compat)
 * @param limit - Maximum requests allowed per 60 seconds (default: 5)
 * @returns Promise resolving to allowed status and current count
 */
export async function checkRateLimit(
  kv: KVNamespace,
  ip: string,
  namespace: string = "revoke",
  limit: number = 5
): Promise<RateLimitResult> {
  const key = `rl:${namespace}:${ip}`;

  try {
    // Get current count
    const currentValue = await kv.get(key);
    const current = currentValue ? parseInt(currentValue, 10) : 0;
    const newCount = current + 1;

    // Update counter with 60s TTL
    await kv.put(key, String(newCount), {
      expirationTtl: 60,
    });

    // Check configured limit
    const allowed = newCount <= limit;

    return { allowed, current: newCount };
  } catch (error) {
    // Fail-open: on KV error, allow the request
    return { allowed: true, current: 0 };
  }
}
