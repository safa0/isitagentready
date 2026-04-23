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
  CheckId,
  CheckResult,
  NextLevel,
  Profile,
  ScanResponse,
} from "@/lib/schema";
import {
  createScanContext,
  type ScanContext,
} from "@/lib/engine/context";
import { detectCommerce } from "@/lib/engine/commerce-signals";
import {
  normaliseScanUrl,
  assertPublicUrl,
} from "@/lib/engine/security";
import {
  DEFAULT_ENABLED_CHECKS,
  scoreScan,
} from "@/lib/engine/scoring";
import { determineLevel } from "@/lib/engine/levels";
import { getRequirement } from "@/lib/engine/prompts";

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

export async function runScan(
  url: string,
  opts: RunScanOptions = {},
): Promise<ScanResponse> {
  const parsed = normaliseScanUrl(url);
  assertPublicUrl(parsed);

  const enabled = resolveEnabledChecks(opts);

  // First-pass context (isCommerce unknown, a2a not yet probed).
  const ctx0 = createScanContext({
    url: parsed,
    fetchImpl: opts.fetchImpl,
  });

  // Step 1: detect commerce.
  const commerce = await detectCommerce(ctx0);

  // Step 2: run a2aAgentCard first if it's enabled (ap2 depends on it).
  let a2aResult: CheckResult | null = null;
  if (enabled.includes("a2aAgentCard")) {
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

  // Step 3: widen context for the remaining checks.
  const ctx = createScanContext({
    url: parsed,
    fetchImpl: opts.fetchImpl,
    isCommerce: commerce.isCommerce,
    a2aAgentCard: a2aResult,
  });

  // Step 4: run all remaining checks in parallel.
  const ALL_IDS: readonly CheckId[] = [
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
    "agentSkills",
    "webMcp",
    "x402",
    "mpp",
    "ucp",
    "acp",
    "ap2",
  ];

  const pairs = await Promise.all(
    ALL_IDS.map(async (id) => [id, await runCheck(id, ctx, enabled)] as const),
  );

  const results: Record<CheckId, CheckResult> = Object.create(null);
  for (const [id, r] of pairs) {
    results[id] = r;
  }
  // a2aAgentCard is NOT in ALL_IDS (pre-run above). Plug in the pre-run
  // result when present, otherwise fall back to the "skipped" neutral.
  results.a2aAgentCard = a2aResult ?? neutralSkipped();

  // Step 5: scoring + level.
  const levelOutcome = determineLevel(results);
  const _score = scoreScan(results, {
    isCommerce: commerce.isCommerce,
    enabledChecks: enabled,
  });
  // NOTE: ScanResponseSchema (captured from the reference scanner) does not
  // include a top-level `score` field — the UI derives it from the checks.
  // We still expose it via computeCategoryScores / scoreScan for consumers.
  void _score;

  // Step 6: compose the response.
  return {
    url: parsed.toString(),
    scannedAt: new Date().toISOString(),
    level: levelOutcome.level,
    levelName: levelOutcome.levelName,
    checks: {
      discoverability: {
        robotsTxt: results.robotsTxt,
        sitemap: results.sitemap,
        linkHeaders: results.linkHeaders,
      },
      contentAccessibility: {
        markdownNegotiation: results.markdownNegotiation,
      },
      botAccessControl: {
        robotsTxtAiRules: results.robotsTxtAiRules,
        contentSignals: results.contentSignals,
        webBotAuth: results.webBotAuth,
      },
      discovery: {
        apiCatalog: results.apiCatalog,
        oauthDiscovery: results.oauthDiscovery,
        oauthProtectedResource: results.oauthProtectedResource,
        mcpServerCard: results.mcpServerCard,
        a2aAgentCard: results.a2aAgentCard,
        agentSkills: results.agentSkills,
        webMcp: results.webMcp,
      },
      commerce: {
        x402: results.x402,
        mpp: results.mpp,
        ucp: results.ucp,
        acp: results.acp,
        ap2: results.ap2,
      },
    },
    nextLevel: buildNextLevel(levelOutcome),
    isCommerce: commerce.isCommerce,
    commerceSignals: [...commerce.commerceSignals],
  };
}
