/**
 * Commerce signal heuristic.
 *
 * Reference: FINDINGS §3 (check category visibility rule) and §9 ("Commerce
 * site detection"). Produces the top-level `isCommerce` / `commerceSignals`
 * fields of the scan response.
 *
 * Signal vocabulary (order-insensitive):
 *   - `platform:<vendor>` — one of `shopify`, `woocommerce`, `magento`,
 *     `bigcommerce`. Detected from HTML body (generator meta, inline script
 *     URLs) or response headers (`x-shopify-*`, `x-magento-*`, `x-powered-by`).
 *   - `meta:<token>` — HTML declares `<meta name="product">`,
 *     `<meta property="og:type" content="product">`, or a platform-named meta
 *     (shopify/etc.).
 *   - `url:/checkout | /product | /shop | /cart` — HEAD probe returns 200.
 *
 * `isCommerce` is true iff at least one signal is detected.
 *
 * Design notes:
 * - Homepage probe is fetched via `ctx.getHomepage()` (shared with
 *   `linkHeaders`, `webMcp`, `markdownNegotiation`). No extra round-trips.
 * - Path HEAD probes are issued concurrently. Per-probe failures are
 *   tolerated — a transport error on `/product` must not suppress a
 *   200 on `/checkout`.
 * - Immutable: the returned object is a fresh record; the helper never
 *   mutates ctx state or any input.
 */

import type { ScanContext } from "@/lib/engine/context";
import type { CheckResult } from "@/lib/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommerceSignalResult {
  readonly isCommerce: boolean;
  readonly commerceSignals: readonly string[];
}

// ---------------------------------------------------------------------------
// Commerce gate (shared with commerce checks)
// ---------------------------------------------------------------------------

const NOT_COMMERCE_SUFFIX = " (not a commerce site)";

/**
 * Transform a commerce-check result based on `isCommerce`. When the site is
 * not a commerce site, we force the status to "neutral" (excluding the check
 * from the scoring denominator per FINDINGS §5) and append a diagnostic
 * suffix to the message so the UI can explain why. Evidence, details, and
 * durationMs are preserved verbatim — the audit view still shows exactly
 * what was probed.
 *
 * Shared here (rather than in a separate helper file) because commerce-signals
 * owns the concept of "commerce-ness" and the gate must stay in sync with the
 * detector. Every commerce check in `checks/` re-exports this via its own
 * import path.
 */
export function applyCommerceGate(
  result: CheckResult,
  isCommerce: boolean,
): CheckResult {
  if (isCommerce) return result;
  return {
    ...result,
    status: "neutral",
    message: result.message + NOT_COMMERCE_SUFFIX,
  };
}

// ---------------------------------------------------------------------------
// Platform heuristics
// ---------------------------------------------------------------------------

interface PlatformRule {
  readonly id: "shopify" | "woocommerce" | "magento" | "bigcommerce";
  /** Test the lowercase homepage body. */
  readonly bodyTokens: readonly string[];
  /** Response headers whose presence indicates the platform. */
  readonly headerNames: readonly string[];
  /** Substring checks against every response header VALUE. */
  readonly headerValues: readonly string[];
}

const PLATFORM_RULES: readonly PlatformRule[] = [
  {
    id: "shopify",
    bodyTokens: [
      'content="shopify',
      "cdn.shopify.com",
      "shopifycloud",
      "myshopify.com",
    ],
    headerNames: ["x-shopify-stage", "x-shopid", "x-shardid"],
    headerValues: [],
  },
  {
    id: "woocommerce",
    bodyTokens: [
      'content="woocommerce',
      "/wp-content/plugins/woocommerce",
      "wc-ajax",
    ],
    headerNames: ["x-wc-store-api-nonce"],
    headerValues: ["woocommerce"],
  },
  {
    id: "magento",
    bodyTokens: [
      'content="magento',
      "/static/frontend/magento",
      "mage-cache-storage",
    ],
    headerNames: ["x-magento-cache-debug", "x-magento-tags"],
    headerValues: [],
  },
  {
    id: "bigcommerce",
    bodyTokens: ["cdn11.bigcommerce.com", 'content="bigcommerce'],
    headerNames: ["x-bc-apigw-request-id"],
    headerValues: ["bigcommerce"],
  },
] as const;

const META_REGEXES: ReadonlyArray<{ signal: string; re: RegExp }> = [
  // <meta name="product" ...> — generic product meta
  { signal: "meta:product", re: /<meta\s+[^>]*name\s*=\s*["']product["'][^>]*>/i },
  // <meta property="og:type" content="product">
  {
    signal: "meta:product",
    re: /<meta\s+[^>]*property\s*=\s*["']og:type["'][^>]*content\s*=\s*["']product["'][^>]*>/i,
  },
];

const PLATFORM_META_REGEXES: ReadonlyArray<{
  id: PlatformRule["id"];
  re: RegExp;
}> = [
  {
    id: "shopify",
    re: /<meta\s+[^>]*(?:name|content)\s*=\s*["'][^"']*shopify[^"']*["'][^>]*>/i,
  },
  {
    id: "woocommerce",
    re: /<meta\s+[^>]*(?:name|content)\s*=\s*["'][^"']*woocommerce[^"']*["'][^>]*>/i,
  },
  {
    id: "magento",
    re: /<meta\s+[^>]*(?:name|content)\s*=\s*["'][^"']*magento[^"']*["'][^>]*>/i,
  },
  {
    id: "bigcommerce",
    re: /<meta\s+[^>]*(?:name|content)\s*=\s*["'][^"']*bigcommerce[^"']*["'][^>]*>/i,
  },
];

const URL_PROBES = [
  "/checkout",
  "/product",
  "/shop",
  "/cart",
] as const;

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

function detectPlatforms(
  body: string,
  headers: Record<string, string>,
): Set<string> {
  const found = new Set<string>();
  const lower = body.toLowerCase();
  for (const rule of PLATFORM_RULES) {
    if (rule.bodyTokens.some((tok) => lower.includes(tok.toLowerCase()))) {
      found.add(`platform:${rule.id}`);
      continue;
    }
    if (rule.headerNames.some((h) => headers[h.toLowerCase()] !== undefined)) {
      found.add(`platform:${rule.id}`);
      continue;
    }
    if (rule.headerValues.length > 0) {
      const joined = Object.values(headers).join(" ").toLowerCase();
      if (rule.headerValues.some((v) => joined.includes(v.toLowerCase()))) {
        found.add(`platform:${rule.id}`);
      }
    }
  }
  return found;
}

function detectMeta(body: string): Set<string> {
  const found = new Set<string>();
  for (const { signal, re } of META_REGEXES) {
    if (re.test(body)) found.add(signal);
  }
  for (const { id, re } of PLATFORM_META_REGEXES) {
    if (re.test(body)) found.add(`meta:${id}`);
  }
  return found;
}

async function detectUrlSignals(ctx: ScanContext): Promise<Set<string>> {
  // Use GET (not HEAD) because some origins reject HEAD; pass a short
  // timeout to avoid blocking the scan if a 404 path hangs.
  const probes = URL_PROBES.map(async (path) => {
    try {
      const outcome = await ctx.fetch(path, { method: "HEAD" });
      if (outcome.response !== undefined && outcome.response.status === 200) {
        return `url:${path}`;
      }
    } catch {
      // Swallow individual probe failures — conservative: no signal.
    }
    return undefined;
  });
  const resolved = await Promise.all(probes);
  return new Set(resolved.filter((s): s is string => s !== undefined));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function detectCommerce(
  ctx: ScanContext,
): Promise<CommerceSignalResult> {
  const [homepage, urlSignals] = await Promise.all([
    ctx.getHomepage(),
    detectUrlSignals(ctx),
  ]);

  const signals = new Set<string>();

  if (homepage.response !== undefined) {
    const body = homepage.body ?? "";
    const headers = homepage.response.headers;
    for (const s of detectPlatforms(body, headers)) signals.add(s);
    for (const s of detectMeta(body)) signals.add(s);
  }

  for (const s of urlSignals) signals.add(s);

  // Sorted for stable output — consumers can rely on order without
  // callers having to sort themselves.
  const commerceSignals = [...signals].sort();
  return {
    isCommerce: commerceSignals.length > 0,
    commerceSignals,
  };
}
