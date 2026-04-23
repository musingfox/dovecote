import type { KVNamespace } from "@cloudflare/workers-types";

export interface RateLimitResult {
  allowed: boolean;
  current: number;
}

/**
 * Check rate limit for admin revoke endpoint (Contract A)
 * - 5 requests per 60 seconds per IP
 * - Fail-open on KV errors (don't block on infrastructure issues)
 *
 * @param kv - KVNamespace for storing counters
 * @param ip - Client IP address
 * @returns Promise resolving to allowed status and current count
 */
export async function checkRateLimit(
  kv: KVNamespace,
  ip: string
): Promise<RateLimitResult> {
  const key = `rl:revoke:${ip}`;

  try {
    // Get current count
    const currentValue = await kv.get(key);
    const current = currentValue ? parseInt(currentValue, 10) : 0;
    const newCount = current + 1;

    // Update counter with 60s TTL
    await kv.put(key, String(newCount), {
      expirationTtl: 60,
    });

    // Check limit (5 req/60s)
    const allowed = newCount <= 5;

    return { allowed, current: newCount };
  } catch (error) {
    // Fail-open: on KV error, allow the request
    return { allowed: true, current: 0 };
  }
}
