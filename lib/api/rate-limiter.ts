/**
 * Per-IP rate limiters for the public HTTP surfaces.
 *
 * Two named buckets are exported:
 * - `defaultRateLimiter` — used by `/api/scan`. 10 requests / 60 s.
 * - `mcpRateLimiter` — used by `/mcp`. Tighter cap (3 / 60 s) because every
 *   `scan_site` tool call fans out to ~19 outbound probes up to 1 MiB each,
 *   which makes the endpoint a potential reflected amplifier. Keeping the
 *   MCP budget smaller than the REST one bounds that amplification.
 *
 * TODO(phase-4): add a per-target-origin bucket so a single caller can't
 * hammer the same victim origin across rotating source IPs.
 *
 * Design notes:
 * - Token-bucket keyed by opaque caller id (typically `extractClientIp(req)`).
 * - Buckets reset fully when the window elapses (simpler than token drip).
 * - Size-bounded: when the map grows beyond `MAX_BUCKETS`, expired entries
 *   are swept on the next write and, as a safety net, any remaining overage
 *   is dropped (oldest `resetAt` first). This defeats an attacker that cycles
 *   IPs (or spoofs `x-forwarded-for` values the platform can't trim) to force
 *   unbounded memory growth.
 * - IP extraction trust posture — see `extractClientIp` for details. On
 *   Vercel the platform-injected `x-vercel-forwarded-for` is authoritative;
 *   outside Vercel, XFF is not trusted unless the operator opts in via the
 *   `TRUST_FORWARDED` env var.
 *
 * The limiter is in-process only. Multi-instance deploys should swap to a
 * Redis/Upstash backend; the `RateLimiter` interface keeps that swap local.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_WINDOW_MS = 60_000;
export const DEFAULT_MAX_REQUESTS = 10;
/** MCP endpoint cap — tighter than REST because of fan-out amplification. */
export const MCP_MAX_REQUESTS = 3;
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

export interface RateLimitSnapshot {
  /** Configured `maxRequests` for this limiter. */
  readonly limit: number;
  /** Remaining budget in the current window (never negative). */
  readonly remaining: number;
  /** Epoch-millis when the current bucket resets (or `now` if no bucket). */
  readonly resetAt: number;
}

export interface RateLimiter {
  /** Returns true when the caller is allowed to proceed. */
  check(key: string, now: number): boolean;
  /** Test hook: drop all state. */
  reset(): void;
  /** Observability hook. */
  size(): number;
  /** Read current window state without consuming a token. */
  snapshot(key: string, now: number): RateLimitSnapshot;
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

  function snapshot(key: string, now: number): RateLimitSnapshot {
    const bucket = buckets.get(key);
    if (bucket === undefined || now >= bucket.resetAt) {
      return { limit: maxRequests, remaining: maxRequests, resetAt: now + windowMs };
    }
    const remaining = Math.max(0, maxRequests - bucket.count);
    return { limit: maxRequests, remaining, resetAt: bucket.resetAt };
  }

  return Object.freeze({ check, reset, size, snapshot });
}

// ---------------------------------------------------------------------------
// Shared default limiters (used by the route handlers)
// ---------------------------------------------------------------------------

export const defaultRateLimiter: RateLimiter = createRateLimiter();

/**
 * Separate bucket for `/mcp`. The MCP tool is a reflected amplifier — each
 * `scan_site` invocation triggers up to 19 outbound probes (1 MiB cap each),
 * so we keep the inbound rate smaller than the REST endpoint's cap.
 */
export const mcpRateLimiter: RateLimiter = createRateLimiter({
  maxRequests: MCP_MAX_REQUESTS,
});

// ---------------------------------------------------------------------------
// Response-header helper
// ---------------------------------------------------------------------------

/**
 * Render standard `X-RateLimit-*` headers from a limiter snapshot. The
 * `X-RateLimit-Reset` value follows the common "epoch-seconds" convention
 * (RFC draft / GitHub / Twitter).
 */
export function rateLimitHeaders(
  snapshot: RateLimitSnapshot,
): Record<string, string> {
  return {
    "x-ratelimit-limit": String(snapshot.limit),
    "x-ratelimit-remaining": String(snapshot.remaining),
    "x-ratelimit-reset": String(Math.ceil(snapshot.resetAt / 1000)),
  };
}

// ---------------------------------------------------------------------------
// IP extraction
// ---------------------------------------------------------------------------

/**
 * Trust posture for the `x-forwarded-for` / `x-real-ip` headers at runtime.
 *
 * We trust forwarded headers when either:
 *   - `VERCEL === "1"` (the platform strips/rewrites XFF and injects
 *     `x-vercel-forwarded-for` itself), or
 *   - the operator has explicitly opted in via `TRUST_FORWARDED === "true"`.
 *
 * Outside both of those worlds, XFF is attacker-controlled and using it as
 * a rate-limit key lets a single caller rotate keys to exhaust the budget.
 * In that case we fall back to a shared `"unknown"` bucket — noisy for
 * legitimate traffic but prevents the bypass. Operators running behind
 * their own trusted reverse proxy should set `TRUST_FORWARDED=true`.
 */
function isForwardedTrusted(): boolean {
  const vercel =
    typeof process !== "undefined" && process.env?.VERCEL === "1";
  const explicit =
    typeof process !== "undefined" &&
    process.env?.TRUST_FORWARDED === "true";
  return vercel || explicit;
}

// Emit a single startup-time warning so operators running off-platform
// without the opt-in understand why they're sharing a single bucket.
(function emitTrustPostureWarning(): void {
  if (typeof process === "undefined") return;
  if (process.env.VERCEL === "1") return;
  if (process.env.TRUST_FORWARDED === "true") return;
  // NODE_ENV=test is noisy if we log here, so gate on that.
  if (process.env.NODE_ENV === "test") return;
  console.warn(
    "[rate-limiter] Running outside Vercel without TRUST_FORWARDED=true; " +
      "XFF-derived IPs may be spoofable — falling back to a shared bucket.",
  );
})();

/**
 * Extract the caller's IP from request headers.
 *
 * Trust-aware priority order:
 *   1. `x-vercel-forwarded-for` RIGHTMOST entry — platform-injected on
 *      Vercel; not client-settable. Parsed rightmost for consistency with
 *      XFF: the last entry is the platform's own annotation of the
 *      immediate peer. Trusted whenever the header is present.
 *   2. (trusted only) `x-forwarded-for` RIGHTMOST entry — the platform's
 *      own annotation of the immediate peer. Using the leftmost entry is
 *      unsafe because it is attacker-controlled.
 *   3. (trusted only) `x-real-ip`.
 *   4. Literal `"unknown"` fallback. Shared across all untrusted callers.
 *
 * "Trusted" means `VERCEL=1` OR `TRUST_FORWARDED=true`. When neither is
 * set, XFF / X-Real-IP are ignored even if present — preventing a
 * spoof-based bypass of the rate limiter on non-Vercel hosts.
 */
export function extractClientIp(req: Request): string {
  const vercelIp = req.headers.get("x-vercel-forwarded-for");
  if (vercelIp !== null) {
    const parts = vercelIp
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parts.length > 0) {
      const last = parts[parts.length - 1];
      if (last !== undefined) return last;
    }
  }
  const trusted = isForwardedTrusted();
  if (trusted) {
    const xff = req.headers.get("x-forwarded-for");
    if (xff !== null) {
      const parts = xff
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (parts.length > 0) {
        const last = parts[parts.length - 1];
        if (last !== undefined) return last;
      }
    }
    const realIp = req.headers.get("x-real-ip");
    if (realIp !== null) {
      const trimmed = realIp.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return "unknown";
}
