/**
 * Scoring engine — formula per FINDINGS §5 / PLAN §Scoring algorithm.
 *
 *     score = round(passes_scored / (passes_scored + fails_scored) * 100)
 *
 * `scored` excludes:
 *   - `status === "neutral"` checks
 *   - commerce checks (x402, mpp, ucp, acp, ap2) when `isCommerce === false`
 *   - any check not in `enabledChecks` (notably `a2aAgentCard` opted-in)
 *
 * Also exports `computeCategoryScores` for the UI's per-category gauges.
 */

import type { CategoryId, CheckId, CheckResult } from "@/lib/schema";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const COMMERCE_CHECK_IDS: readonly CheckId[] = [
  "x402",
  "mpp",
  "ucp",
  "acp",
  "ap2",
];

/**
 * Default `enabledChecks` for a scan. All 19 IDs except `a2aAgentCard`,
 * which is an opt-in per PLAN §Scoring algorithm.
 */
export const DEFAULT_ENABLED_CHECKS: readonly CheckId[] = [
  "robotsTxt",
  "sitemap",
  "linkHeaders",
  "markdownNegotiation",
  "robotsTxtAiRules",
  "contentSignals",
  "webBotAuth",
  "apiCatalog",
  "oauthDiscovery",
  "oauthProtectedResource",
  "mcpServerCard",
  // "a2aAgentCard" - off by default
  "agentSkills",
  "webMcp",
  "x402",
  "mpp",
  "ucp",
  "acp",
  "ap2",
];

/** Category membership map — single source of truth for UI + scoring. */
export const CHECK_CATEGORY: Readonly<Record<CheckId, CategoryId>> = {
  robotsTxt: "discoverability",
  sitemap: "discoverability",
  linkHeaders: "discoverability",
  markdownNegotiation: "contentAccessibility",
  robotsTxtAiRules: "botAccessControl",
  contentSignals: "botAccessControl",
  webBotAuth: "botAccessControl",
  apiCatalog: "discovery",
  oauthDiscovery: "discovery",
  oauthProtectedResource: "discovery",
  mcpServerCard: "discovery",
  a2aAgentCard: "discovery",
  agentSkills: "discovery",
  webMcp: "discovery",
  x402: "commerce",
  mpp: "commerce",
  ucp: "commerce",
  acp: "commerce",
  ap2: "commerce",
};

export const ALL_CHECK_IDS: readonly CheckId[] = Object.keys(
  CHECK_CATEGORY,
) as CheckId[];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScoreOptions {
  readonly isCommerce: boolean;
  readonly enabledChecks: readonly CheckId[];
}

export interface CategoryScore {
  readonly score: number;
  readonly passes: number;
  readonly fails: number;
  readonly total: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isScored(
  checkId: CheckId,
  result: CheckResult | undefined,
  opts: ScoreOptions,
): boolean {
  if (result === undefined) return false;
  if (result.status === "neutral") return false;
  if (!opts.enabledChecks.includes(checkId)) return false;
  if (COMMERCE_CHECK_IDS.includes(checkId) && !opts.isCommerce) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function scoreScan(
  results: Record<CheckId, CheckResult>,
  opts: ScoreOptions,
): number {
  let passes = 0;
  let fails = 0;
  for (const id of ALL_CHECK_IDS) {
    const r = results[id];
    if (r === undefined) continue;
    if (!isScored(id, r, opts)) continue;
    if (r.status === "pass") passes += 1;
    else if (r.status === "fail") fails += 1;
  }
  const denom = passes + fails;
  if (denom === 0) return 0;
  return Math.round((passes / denom) * 100);
}

export function computeCategoryScores(
  results: Record<CheckId, CheckResult>,
  opts: ScoreOptions,
): Record<CategoryId, CategoryScore> {
  const buckets: Record<CategoryId, { passes: number; fails: number }> = {
    discoverability: { passes: 0, fails: 0 },
    contentAccessibility: { passes: 0, fails: 0 },
    botAccessControl: { passes: 0, fails: 0 },
    discovery: { passes: 0, fails: 0 },
    commerce: { passes: 0, fails: 0 },
  };
  for (const id of ALL_CHECK_IDS) {
    const r = results[id];
    if (r === undefined) continue;
    if (!isScored(id, r, opts)) continue;
    const cat = CHECK_CATEGORY[id];
    if (r.status === "pass") buckets[cat].passes += 1;
    else if (r.status === "fail") buckets[cat].fails += 1;
  }
  const out: Partial<Record<CategoryId, CategoryScore>> = {};
  for (const cat of Object.keys(buckets) as CategoryId[]) {
    const { passes, fails } = buckets[cat];
    const total = passes + fails;
    const score = total === 0 ? 0 : Math.round((passes / total) * 100);
    out[cat] = { score, passes, fails, total };
  }
  return out as Record<CategoryId, CategoryScore>;
}
