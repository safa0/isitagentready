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
  // Strip a single trailing period before appending the suffix so future
  // messages ending in "." don't produce "foo. (not a commerce site)".
  const base = result.message.endsWith(".")
    ? result.message.slice(0, -1)
    : result.message;
  return {
    ...result,
    status: "neutral",
    message: base + NOT_COMMERCE_SUFFIX,
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

// Body tokens are kept narrow — each token points at a platform-specific CDN,
// plugin path, or internal script name. Descriptive copy like
// `<meta name="description" content="shopify your store">` must NOT trigger a
// platform match (see PLATFORM_META_REGEXES for the meta-tag route).
const PLATFORM_RULES: readonly PlatformRule[] = [
  {
    id: "shopify",
    bodyTokens: ["cdn.shopify.com", "shopifycloud", "myshopify.com"],
    headerNames: ["x-shopify-stage", "x-shopid", "x-shardid"],
    headerValues: [],
  },
  {
    id: "woocommerce",
    bodyTokens: ["/wp-content/plugins/woocommerce", "wc-ajax"],
    headerNames: ["x-wc-store-api-nonce"],
    headerValues: ["woocommerce"],
  },
  {
    id: "magento",
    bodyTokens: ["/static/frontend/magento", "mage-cache-storage"],
    headerNames: ["x-magento-cache-debug", "x-magento-tags"],
    headerValues: [],
  },
  {
    id: "bigcommerce",
    bodyTokens: ["cdn11.bigcommerce.com"],
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

/**
 * Platform meta regexes. We deliberately scope matches to three narrow shapes
 * so unrelated descriptive copy doesn't trigger a false positive:
 *   1. `<meta name="generator" content="...shopify...">` — the conventional
 *      CMS/platform self-identification meta (name-first).
 *   2. `<meta content="...shopify..." name="generator">` — the same meta
 *      with reversed attribute order (valid per HTML; emitted by some CMSs).
 *   3. `<meta name="shopify...">` / `<meta name="woocommerce...">` etc. —
 *      a platform-named meta tag.
 * A previous implementation matched any meta attribute value containing the
 * vendor token, which over-matched pages like
 * `<meta name="description" content="How to shopify your store">`.
 */
const PLATFORM_META_REGEXES: ReadonlyArray<{
  id: PlatformRule["id"];
  re: RegExp;
}> = [
  {
    id: "shopify",
    re: /<meta\s+[^>]*name\s*=\s*["']generator["'][^>]*content\s*=\s*["'][^"']*shopify[^"']*["']|<meta\s+[^>]*content\s*=\s*["'][^"']*shopify[^"']*["'][^>]*name\s*=\s*["']generator["']|<meta\s+[^>]*name\s*=\s*["']shopify[^"']*["']/i,
  },
  {
    id: "woocommerce",
    re: /<meta\s+[^>]*name\s*=\s*["']generator["'][^>]*content\s*=\s*["'][^"']*woocommerce[^"']*["']|<meta\s+[^>]*content\s*=\s*["'][^"']*woocommerce[^"']*["'][^>]*name\s*=\s*["']generator["']|<meta\s+[^>]*name\s*=\s*["']woocommerce[^"']*["']/i,
  },
  {
    id: "magento",
    re: /<meta\s+[^>]*name\s*=\s*["']generator["'][^>]*content\s*=\s*["'][^"']*magento[^"']*["']|<meta\s+[^>]*content\s*=\s*["'][^"']*magento[^"']*["'][^>]*name\s*=\s*["']generator["']|<meta\s+[^>]*name\s*=\s*["']magento[^"']*["']/i,
  },
  {
    id: "bigcommerce",
    re: /<meta\s+[^>]*name\s*=\s*["']generator["'][^>]*content\s*=\s*["'][^"']*bigcommerce[^"']*["']|<meta\s+[^>]*content\s*=\s*["'][^"']*bigcommerce[^"']*["'][^>]*name\s*=\s*["']generator["']|<meta\s+[^>]*name\s*=\s*["']bigcommerce[^"']*["']/i,
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
): string[] {
  const found: string[] = [];
  const lower = body.toLowerCase();
  for (const rule of PLATFORM_RULES) {
    if (rule.bodyTokens.some((tok) => lower.includes(tok.toLowerCase()))) {
      found.push(`platform:${rule.id}`);
      continue;
    }
    if (rule.headerNames.some((h) => headers[h.toLowerCase()] !== undefined)) {
      found.push(`platform:${rule.id}`);
      continue;
    }
    if (rule.headerValues.length > 0) {
      const joined = Object.values(headers).join(" ").toLowerCase();
      if (rule.headerValues.some((v) => joined.includes(v.toLowerCase()))) {
        found.push(`platform:${rule.id}`);
      }
    }
  }
  return found;
}

function detectMeta(body: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const { id, re } of PLATFORM_META_REGEXES) {
    const signal = `meta:${id}`;
    if (!seen.has(signal) && re.test(body)) {
      seen.add(signal);
      found.push(signal);
    }
  }
  for (const { signal, re } of META_REGEXES) {
    if (!seen.has(signal) && re.test(body)) {
      seen.add(signal);
      found.push(signal);
    }
  }
  return found;
}

async function detectUrlSignals(ctx: ScanContext): Promise<string[]> {
  // Use HEAD to minimise response size; most origins honour HEAD on /checkout,
  // /product, /shop, /cart. Order is preserved by returning probes in
  // `URL_PROBES` declaration order — the final signal list deliberately keeps
  // platform:* → meta:* → url:* detection order (see `detectCommerce`).
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
  return resolved.filter((s): s is string => s !== undefined);
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

  // Preserve detection order: `platform:* → meta:* → url:*`. The shopify
  // oracle (`research/raw/scan-shopify.json` commerceSignals) emits signals
  // in this order, and downstream consumers may rely on it (scoring, UI
  // grouping). Within each bucket, order is preserved per the detector's
  // declaration order (PLATFORM_RULES / META_REGEXES / URL_PROBES).
  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (s: string): void => {
    if (!seen.has(s)) {
      seen.add(s);
      ordered.push(s);
    }
  };

  if (homepage.response !== undefined) {
    const body = homepage.body ?? "";
    const headers = homepage.response.headers;
    for (const s of detectPlatforms(body, headers)) push(s);
    for (const s of detectMeta(body)) push(s);
  }
  for (const s of urlSignals) push(s);

  return {
    isCommerce: ordered.length > 0,
    commerceSignals: ordered,
  };
}

// TODO(phase-3): When the orchestrator wires checks together it will normalise
// the signature shape for commerce checks by widening `ScanContext` to include
// `isCommerce` / `commerceSignals` directly (M4-norm from iter-1 review), so
// individual checks no longer need a bespoke `opts.isCommerce` parameter.
