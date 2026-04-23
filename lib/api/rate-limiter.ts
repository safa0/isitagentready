/**
 * Per-IP rate limiter shared by the public HTTP surfaces (`/api/scan`, `/mcp`).
 *
 * Design notes:
 * - Token-bucket keyed by opaque caller id (typically `extractClientIp(req)`).
 * - Buckets reset fully when the window elapses (simpler than token drip).
 * - Size-bounded: when the map grows beyond `MAX_BUCKETS`, expired entries
 *   are swept on the next write and, as a safety net, any remaining overage
 *   is dropped (oldest `resetAt` first). This defeats an attacker that cycles
 *   IPs (or spoofs `x-forwarded-for` values the platform can't trim) to force
 *   unbounded memory growth.
 * - IP extraction prefers `x-vercel-forwarded-for` (platform-injected, not
 *   client-settable). Falls back to the RIGHT-most `x-forwarded-for` entry,
 *   which is the platform's own annotation of the immediate peer. The LEFT-
 *   most XFF is attacker-controlled — using it would let an attacker bypass
 *   the limiter by forging a different origin IP on each request.
 *
 * The limiter is in-process only. Multi-instance deploys should swap to a
 * Redis/Upstash backend; the `RateLimiter` interface keeps that swap local.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_WINDOW_MS = 60_000;
export const DEFAULT_MAX_REQUESTS = 10;
/** Hard cap on retained bucket entries. Swept lazily on write. */
export const MAX_BUCKETS = 10_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimiterOptions {
  readonly windowMs?: number;
  readonly maxRequests?: number;
  readonly maxBuckets?: number;
}

export interface RateLimiter {
  /** Returns true when the caller is allowed to proceed. */
  check(key: string, now: number): boolean;
  /** Test hook: drop all state. */
  reset(): void;
  /** Observability hook. */
  size(): number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRateLimiter(
  options: RateLimiterOptions = {},
): RateLimiter {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const maxBuckets = options.maxBuckets ?? MAX_BUCKETS;

  const buckets = new Map<string, Bucket>();

  /**
   * Evict expired entries. When the map is still at/over `maxBuckets`, also
   * drop the oldest-resetAt entries to make headroom for the incoming write.
   * We leave the map at `maxBuckets - 1` entries so the caller's `set` lands
   * at exactly `maxBuckets`.
   */
  function sweep(now: number): void {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) {
        buckets.delete(key);
      }
    }
    if (buckets.size < maxBuckets) return;
    const sortedByReset = Array.from(buckets.entries()).sort(
      (a, b) => a[1].resetAt - b[1].resetAt,
    );
    // Shrink to `maxBuckets - 1` so the caller's insertion fits within cap.
    const target = Math.max(0, maxBuckets - 1);
    const overage = buckets.size - target;
    for (let i = 0; i < overage; i += 1) {
      const entry = sortedByReset[i];
      if (entry === undefined) break;
      buckets.delete(entry[0]);
    }
  }

  function check(key: string, now: number): boolean {
    const bucket = buckets.get(key);
    if (bucket === undefined || now >= bucket.resetAt) {
      if (buckets.size >= maxBuckets) sweep(now);
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (bucket.count >= maxRequests) return false;
    bucket.count += 1;
    return true;
  }

  function reset(): void {
    buckets.clear();
  }

  function size(): number {
    return buckets.size;
  }

  return Object.freeze({ check, reset, size });
}

// ---------------------------------------------------------------------------
// Shared default limiter (used by the route handlers)
// ---------------------------------------------------------------------------

export const defaultRateLimiter: RateLimiter = createRateLimiter();

// ---------------------------------------------------------------------------
// IP extraction
// ---------------------------------------------------------------------------

/**
 * Extract the caller's IP from request headers.
 *
 * Priority order:
 *   1. `x-vercel-forwarded-for` — platform-injected on Vercel; not
 *      client-settable.
 *   2. `x-forwarded-for` RIGHTMOST entry — the platform's own annotation
 *      of the immediate peer. Using the leftmost entry (common but wrong)
 *      lets an attacker forge a bypass by setting `x-forwarded-for: x`.
 *   3. `x-real-ip`.
 *   4. Literal `"unknown"` fallback.
 *
 * Any untrusted input is trimmed and never passed through URL decoding.
 */
export function extractClientIp(req: Request): string {
  const vercelIp = req.headers.get("x-vercel-forwarded-for");
  if (vercelIp !== null) {
    const first = vercelIp.split(",")[0]?.trim();
    if (first !== undefined && first.length > 0) return first;
  }
  const xff = req.headers.get("x-forwarded-for");
  if (xff !== null) {
    const parts = xff
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parts.length > 0) return parts[parts.length - 1]!;
  }
  const realIp = req.headers.get("x-real-ip");
  if (realIp !== null) {
    const trimmed = realIp.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "unknown";
}
