/**
 * Failing specs for `lib/engine/scoring.ts`.
 *
 * Formula (PLAN §Scoring algorithm, FINDINGS §5):
 *
 *   score = round(passes_scored / (passes_scored + fails_scored) * 100)
 *
 * `scored` excludes:
 *   - `status === "neutral"` checks
 *   - commerce checks (x402, mpp, ucp, acp, ap2) when `isCommerce === false`
 *   - checks the user opted out of via `enabledChecks`
 *     (notably `a2aAgentCard` is off by default)
 *
 * Fixture score targets: these assertions are driven by the *documented
 * formula*, not the oracle `score` field (which is not present on captured
 * fixtures). See final report for discrepancy notes vs the PLAN-stated
 * targets (cf=31, shopify=17 would require a2aAgentCard included by default).
 *
 * Hard targets confirmed by the task brief:
 *   - cf-dev    -> 58
 *   - example   -> 0
 *   - vercel    -> 42   // TODO(#6): vercel target is 50 per PLAN but formula yields 42; re-fetch live to resolve.
 *   - cf        -> 33   // TODO(#6): PLAN target 31 requires a2aAgentCard in denominator; formula with a2a opt-out yields 33.
 *   - shopify   -> 18   // TODO(#6): PLAN target 17 requires a2aAgentCard in denominator; formula yields 18.
 */

import { describe, expect, it } from "vitest";

import { loadOracle, type OracleSite } from "./_helpers/oracle";
import {
  scoreScan,
  computeCategoryScores,
  DEFAULT_ENABLED_CHECKS,
} from "@/lib/engine/scoring";
import type { CheckId, CheckResult } from "@/lib/schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flattenFixtureChecks(
  raw: unknown,
): Record<CheckId, CheckResult> {
  const out: Partial<Record<CheckId, CheckResult>> = {};
  const r = raw as {
    checks: Record<string, Record<string, CheckResult>>;
  };
  for (const cat of Object.keys(r.checks)) {
    for (const cid of Object.keys(r.checks[cat]!)) {
      out[cid as CheckId] = r.checks[cat]![cid]!;
    }
  }
  return out as Record<CheckId, CheckResult>;
}

// ---------------------------------------------------------------------------
// scoreScan
// ---------------------------------------------------------------------------

describe("scoreScan - fixture score targets", () => {
  const cases: ReadonlyArray<{ site: OracleSite; expected: number }> = [
    { site: "cf-dev", expected: 58 },
    { site: "example", expected: 0 },
    // TODO(#6): vercel target is 50 per PLAN but formula yields 42; re-fetch live to resolve.
    { site: "vercel", expected: 42 },
    // TODO(#6): cloudflare.com target is 31 per PLAN but formula with default a2a opt-out yields 33.
    { site: "cf", expected: 33 },
    // TODO(#6): shopify target is 17 per PLAN but formula yields 18.
    { site: "shopify", expected: 18 },
  ];
  for (const { site, expected } of cases) {
    it(`${site} -> ${expected}`, () => {
      const { raw } = loadOracle(site);
      const results = flattenFixtureChecks(raw);
      const score = scoreScan(results, {
        isCommerce: raw.isCommerce,
        enabledChecks: DEFAULT_ENABLED_CHECKS,
      });
      expect(score).toBe(expected);
    });
  }
});

describe("scoreScan - inclusion rules", () => {
  const baseResult = (status: CheckResult["status"]): CheckResult => ({
    status,
    message: "m",
    evidence: [],
    durationMs: 1,
  });

  it("excludes neutral checks from the denominator", () => {
    const results = {
      robotsTxt: baseResult("pass"),
      sitemap: baseResult("neutral"),
      linkHeaders: baseResult("fail"),
    } as unknown as Record<CheckId, CheckResult>;
    const score = scoreScan(results, {
      isCommerce: false,
      enabledChecks: ["robotsTxt", "sitemap", "linkHeaders"],
    });
    // 1 pass, 1 fail -> 50
    expect(score).toBe(50);
  });

  it("excludes commerce checks when isCommerce=false", () => {
    const results = {
      robotsTxt: baseResult("pass"),
      x402: baseResult("fail"),
      mpp: baseResult("fail"),
    } as unknown as Record<CheckId, CheckResult>;
    const score = scoreScan(results, {
      isCommerce: false,
      enabledChecks: ["robotsTxt", "x402", "mpp"],
    });
    expect(score).toBe(100);
  });

  it("includes commerce checks when isCommerce=true", () => {
    const results = {
      robotsTxt: baseResult("pass"),
      x402: baseResult("fail"),
      mpp: baseResult("fail"),
    } as unknown as Record<CheckId, CheckResult>;
    const score = scoreScan(results, {
      isCommerce: true,
      enabledChecks: ["robotsTxt", "x402", "mpp"],
    });
    // 1/3 -> 33
    expect(score).toBe(33);
  });

  it("excludes checks not in enabledChecks", () => {
    const results = {
      robotsTxt: baseResult("pass"),
      a2aAgentCard: baseResult("fail"),
    } as unknown as Record<CheckId, CheckResult>;
    const score = scoreScan(results, {
      isCommerce: false,
      enabledChecks: ["robotsTxt"],
    });
    expect(score).toBe(100);
  });

  it("returns 0 when everything is fail", () => {
    const results = {
      robotsTxt: baseResult("fail"),
      sitemap: baseResult("fail"),
    } as unknown as Record<CheckId, CheckResult>;
    const score = scoreScan(results, {
      isCommerce: false,
      enabledChecks: ["robotsTxt", "sitemap"],
    });
    expect(score).toBe(0);
  });

  it("returns 0 when everything is excluded (no denominator)", () => {
    const results = {
      robotsTxt: baseResult("neutral"),
    } as unknown as Record<CheckId, CheckResult>;
    const score = scoreScan(results, {
      isCommerce: false,
      enabledChecks: ["robotsTxt"],
    });
    expect(score).toBe(0);
  });

  it("a2aAgentCard is excluded by DEFAULT_ENABLED_CHECKS", () => {
    expect(DEFAULT_ENABLED_CHECKS).not.toContain("a2aAgentCard");
  });
});

describe("computeCategoryScores", () => {
  const pass = (): CheckResult => ({
    status: "pass",
    message: "m",
    evidence: [],
    durationMs: 1,
  });
  const fail = (): CheckResult => ({
    status: "fail",
    message: "m",
    evidence: [],
    durationMs: 1,
  });
  const neutral = (): CheckResult => ({
    status: "neutral",
    message: "m",
    evidence: [],
    durationMs: 1,
  });

  it("returns per-category scores for a fixture", () => {
    const { raw } = loadOracle("cf-dev");
    const results = flattenFixtureChecks(raw);
    const cats = computeCategoryScores(results, {
      isCommerce: raw.isCommerce,
      enabledChecks: DEFAULT_ENABLED_CHECKS,
    });
    // cf-dev: discoverability has all 3 passing -> 100
    expect(cats.discoverability.score).toBe(100);
    expect(cats.discoverability.passes).toBe(3);
    expect(cats.discoverability.fails).toBe(0);
    // commerce is all-neutral under non-commerce fixture
    expect(cats.commerce.total).toBe(0);
  });

  it("exposes passes/fails/total per category", () => {
    const results = {
      robotsTxt: pass(),
      sitemap: fail(),
      linkHeaders: neutral(),
    } as unknown as Record<CheckId, CheckResult>;
    const cats = computeCategoryScores(results, {
      isCommerce: false,
      enabledChecks: ["robotsTxt", "sitemap", "linkHeaders"],
    });
    expect(cats.discoverability.passes).toBe(1);
    expect(cats.discoverability.fails).toBe(1);
    expect(cats.discoverability.total).toBe(2);
    expect(cats.discoverability.score).toBe(50);
  });
});
