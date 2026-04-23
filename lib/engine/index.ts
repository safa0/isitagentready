/**
 * Engine orchestrator — `runScan(url, opts?)`.
 *
 * Phase 3 wiring:
 *   1. Validate + normalise the URL (SSRF guard).
 *   2. Create a first-pass `ScanContext` (isCommerce=false, a2aAgentCard=null).
 *   3. Run `detectCommerce(ctx)` to derive `{ isCommerce, commerceSignals }`.
 *   4. If `a2aAgentCard` is in `enabledChecks`, run `checkA2aAgentCard(ctx)`
 *      first so `ap2` can read the result off the widened context.
 *   5. Create a second-pass `ScanContext` with the widened values.
 *   6. Run the remaining 18 checks in parallel.
 *   7. Compute score + level + nextLevel.
 *   8. Return a `ScanResponse` that matches `ScanResponseSchema`.
 */

import type {
  CategoryId,
  CheckId,
  CheckResult,
  NextLevel,
  Profile,
  ScanResponse,
} from "@/lib/schema";
import {
  createScanContext,
  createSharedProbes,
  type ScanContext,
} from "@/lib/engine/context";
import { detectCommerce } from "@/lib/engine/commerce-signals";
import {
  normaliseScanUrl,
  assertPublicUrl,
  ScanUrlError,
} from "@/lib/engine/security";
import {
  ALL_CHECK_IDS,
  CHECK_CATEGORY,
  DEFAULT_ENABLED_CHECKS,
} from "@/lib/engine/scoring";
import { determineLevel } from "@/lib/engine/levels";
import { getRequirement } from "@/lib/engine/prompts";

// Re-export so API/MCP routes can discriminate SSRF errors from generic
// engine failures without importing `lib/engine/security.ts` directly.
export { ScanUrlError };

import { checkRobotsTxt } from "@/lib/engine/checks/robots-txt";
import { checkSitemap } from "@/lib/engine/checks/sitemap";
import { checkLinkHeaders } from "@/lib/engine/checks/link-headers";
import { checkMarkdownNegotiation } from "@/lib/engine/checks/markdown-negotiation";
import { checkRobotsTxtAiRules } from "@/lib/engine/checks/robots-ai-rules";
import { checkContentSignals } from "@/lib/engine/checks/content-signals";
import { checkWebBotAuth } from "@/lib/engine/checks/web-bot-auth";
import { checkApiCatalog } from "@/lib/engine/checks/api-catalog";
import { checkOauthDiscovery } from "@/lib/engine/checks/oauth-discovery";
import { checkOauthProtectedResource } from "@/lib/engine/checks/oauth-protected-resource";
import { checkMcpServerCard } from "@/lib/engine/checks/mcp-server-card";
import { checkA2aAgentCard } from "@/lib/engine/checks/a2a-agent-card";
import { checkAgentSkills } from "@/lib/engine/checks/agent-skills";
import { checkWebMcp } from "@/lib/engine/checks/web-mcp";
import { checkX402 } from "@/lib/engine/checks/x402";
import { checkMpp } from "@/lib/engine/checks/mpp";
import { checkUcp } from "@/lib/engine/checks/ucp";
import { checkAcp } from "@/lib/engine/checks/acp";
import { checkAp2 } from "@/lib/engine/checks/ap2";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunScanOptions {
  readonly profile?: Profile;
  readonly enabledChecks?: readonly CheckId[];
  /** Injectable fetch for tests. */
  readonly fetchImpl?: typeof fetch;
  /** Hard cap for the whole scan, in ms. Defaults to 60_000. */
  readonly timeoutMs?: number;
  /**
   * Optional cancellation signal. When aborted every in-flight probe is
   * cancelled. Consumed by the HTTP route's timeout handling.
   */
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/**
 * Per-profile opt-out lists. `enabledChecks` ultimately wins — the profile
 * is just a preset that selects a subset of `DEFAULT_ENABLED_CHECKS`.
 */
const PROFILE_OVERRIDES: Readonly<Record<Profile, readonly CheckId[]>> = {
  all: DEFAULT_ENABLED_CHECKS,
  content: DEFAULT_ENABLED_CHECKS.filter(
    (id) => !["x402", "mpp", "ucp", "acp", "ap2"].includes(id),
  ),
  apiApp: DEFAULT_ENABLED_CHECKS.filter(
    (id) => !["markdownNegotiation", "contentSignals"].includes(id),
  ),
};

function resolveEnabledChecks(opts: RunScanOptions): readonly CheckId[] {
  if (opts.enabledChecks !== undefined) return opts.enabledChecks;
  const profile = opts.profile ?? "all";
  return PROFILE_OVERRIDES[profile];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function neutralSkipped(): CheckResult {
  return {
    status: "neutral",
    message: "Check skipped (not enabled).",
    evidence: [],
    durationMs: 0,
  };
}

type RunnerWithCtx = (ctx: ScanContext) => Promise<CheckResult>;

const RUNNERS: Readonly<Record<CheckId, RunnerWithCtx>> = {
  robotsTxt: checkRobotsTxt,
  sitemap: checkSitemap,
  linkHeaders: checkLinkHeaders,
  markdownNegotiation: checkMarkdownNegotiation,
  robotsTxtAiRules: checkRobotsTxtAiRules,
  contentSignals: checkContentSignals,
  webBotAuth: checkWebBotAuth,
  apiCatalog: checkApiCatalog,
  oauthDiscovery: checkOauthDiscovery,
  oauthProtectedResource: checkOauthProtectedResource,
  mcpServerCard: checkMcpServerCard,
  a2aAgentCard: checkA2aAgentCard,
  agentSkills: checkAgentSkills,
  webMcp: checkWebMcp,
  x402: checkX402,
  mpp: checkMpp,
  ucp: checkUcp,
  acp: checkAcp,
  ap2: checkAp2,
};

async function runCheck(
  id: CheckId,
  ctx: ScanContext,
  enabled: readonly CheckId[],
): Promise<CheckResult> {
  if (!enabled.includes(id)) return neutralSkipped();
  try {
    return await RUNNERS[id](ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: "neutral",
      message: `Check errored: ${message}`,
      evidence: [],
      durationMs: 0,
    };
  }
}

/**
 * Project flat `results` into the categorised `ScanResponse.checks` shape,
 * driven entirely by `CHECK_CATEGORY`. A missing result (e.g. a check id
 * absent from `results` for any reason) is backfilled with a neutral
 * "skipped" record so the response always satisfies `ChecksBlockSchema`.
 */
function projectByCategory(
  results: Record<CheckId, CheckResult>,
): ScanResponse["checks"] {
  const out: Record<CategoryId, Record<string, CheckResult>> = {
    discoverability: {},
    contentAccessibility: {},
    botAccessControl: {},
    discovery: {},
    commerce: {},
  };
  for (const id of ALL_CHECK_IDS) {
    out[CHECK_CATEGORY[id]][id] = results[id] ?? neutralSkipped();
  }
  return out as ScanResponse["checks"];
}

function buildNextLevel(
  outcome: ReturnType<typeof determineLevel>,
): NextLevel | null {
  if (outcome.nextLevel === null) return null;
  return {
    target: outcome.nextLevel.level as 1 | 2 | 3 | 4 | 5,
    name: outcome.nextLevel.name,
    requirements: outcome.nextLevel.requirements.map(getRequirement),
  };
}

// ---------------------------------------------------------------------------
// runScan
// ---------------------------------------------------------------------------

/**
 * `a2aAgentCard` is pre-run before commerce widening so `ap2` can read the
 * result off the context. Every other check is eligible for parallel dispatch.
 */
const PRE_RUN_IDS: ReadonlySet<CheckId> = new Set<CheckId>(["a2aAgentCard"]);
const PARALLEL_IDS: readonly CheckId[] = ALL_CHECK_IDS.filter(
  (id) => !PRE_RUN_IDS.has(id),
);

async function safeDetectCommerce(
  ctx: ScanContext,
): Promise<{ isCommerce: boolean; commerceSignals: readonly string[] }> {
  try {
    return await detectCommerce(ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The commerce heuristic is advisory. A throwing detector must not
    // abort the entire scan — fall back to "not commerce" and log.
    console.error("[runScan] detectCommerce failed:", message);
    return { isCommerce: false, commerceSignals: [] };
  }
}

export async function runScan(
  url: string,
  opts: RunScanOptions = {},
): Promise<ScanResponse> {
  const parsed = normaliseScanUrl(url);
  assertPublicUrl(parsed);

  const enabled = resolveEnabledChecks(opts);
  const a2aEnabled = enabled.includes("a2aAgentCard");

  // Shared probe memo so the pre-run and widened contexts share a single
  // in-flight homepage/robots fetch each.
  const sharedProbes = createSharedProbes();

  // First-pass context (isCommerce unknown, a2a not yet probed).
  const ctx0 = createScanContext({
    url: parsed,
    fetchImpl: opts.fetchImpl,
    signal: opts.signal,
    sharedProbes,
    a2aAgentCardEnabled: a2aEnabled,
  });

  // Step 1: detect commerce (guarded — advisory only).
  const commerce = await safeDetectCommerce(ctx0);

  // Step 2: run a2aAgentCard first if it's enabled (ap2 depends on it).
  let a2aResult: CheckResult | null = null;
  if (a2aEnabled) {
    try {
      a2aResult = await checkA2aAgentCard(ctx0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      a2aResult = {
        status: "neutral",
        message: `Check errored: ${message}`,
        evidence: [],
        durationMs: 0,
      };
    }
  }

  // Step 3: widen context for the remaining checks, re-using the shared
  // probe memo so the second pass hits the warm cache.
  const ctx = createScanContext({
    url: parsed,
    fetchImpl: opts.fetchImpl,
    signal: opts.signal,
    sharedProbes,
    isCommerce: commerce.isCommerce,
    a2aAgentCard: a2aResult,
    a2aAgentCardEnabled: a2aEnabled,
  });

  // Step 4: run all remaining checks in parallel. Dispatch synchronously
  // (map returns the pending promises up-front) and only await the collective
  // result via Promise.all — the `.then` pair shape makes that explicit.
  const pairs = await Promise.all(
    PARALLEL_IDS.map((id) =>
      runCheck(id, ctx, enabled).then((r) => [id, r] as const),
    ),
  );

  const results: Record<CheckId, CheckResult> = Object.create(null);
  for (const [id, r] of pairs) {
    results[id] = r;
  }
  // a2aAgentCard is NOT in PARALLEL_IDS (pre-run above). Plug in the pre-run
  // result when present, otherwise fall back to the "skipped" neutral.
  results.a2aAgentCard = a2aResult ?? neutralSkipped();

  // Step 5: level calculation. Scoring is intentionally NOT computed here —
  // the response schema (captured from the reference scanner) has no
  // top-level score, so each consumer (UI / agent) calls `scoreScan`
  // directly over `results` with the profile it needs.
  const levelOutcome = determineLevel(results);

  // Step 6: compose the response.
  return {
    url: parsed.toString(),
    scannedAt: new Date().toISOString(),
    level: levelOutcome.level,
    levelName: levelOutcome.levelName,
    checks: projectByCategory(results),
    nextLevel: buildNextLevel(levelOutcome),
    isCommerce: commerce.isCommerce,
    commerceSignals: [...commerce.commerceSignals],
  };
}
