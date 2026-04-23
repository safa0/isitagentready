/**
 * Failing specs for `lib/engine/levels.ts`.
 *
 * Level ladder (PLAN §Phases Phase 3):
 *   L0 Not Ready (baseline)
 *   L1 Basic Web Presence: robotsTxt, sitemap
 *   L2 Bot-Aware:          L1 + robotsTxtAiRules, contentSignals
 *   L3 Agent-Readable:     L2 + markdownNegotiation
 *   L4 Agent-Integrated:   L3 + linkHeaders, agentSkills
 *   L5 Agent-Native:       L4 + apiCatalog, oauthProtectedResource,
 *                               mcpServerCard, a2aAgentCard
 *
 * Each oracle fixture carries a captured `level` field — we round-trip
 * the determineLevel computation against each.
 */

import { describe, expect, it } from "vitest";

import { loadOracle, type OracleSite } from "./_helpers/oracle";
import { determineLevel } from "@/lib/engine/levels";
import type { CheckId, CheckResult } from "@/lib/schema";

function flatten(raw: unknown): Record<CheckId, CheckResult> {
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

describe("determineLevel - fixture round-trip", () => {
  const cases: ReadonlyArray<OracleSite> = [
    "cf-dev",
    "example",
    "vercel",
    "cf",
    "shopify",
  ];
  for (const site of cases) {
    it(`${site} matches oracle level + levelName`, () => {
      const { raw } = loadOracle(site);
      const results = flatten(raw);
      const out = determineLevel(results);
      expect(out.level).toBe(raw.level);
      expect(out.levelName).toBe(raw.levelName);
    });
  }
});

describe("determineLevel - synthetic ladder", () => {
  const pass = (): CheckResult => ({
    status: "pass",
    message: "ok",
    evidence: [],
    durationMs: 1,
  });
  const fail = (): CheckResult => ({
    status: "fail",
    message: "bad",
    evidence: [],
    durationMs: 1,
  });

  function makeResults(
    passing: readonly CheckId[],
  ): Record<CheckId, CheckResult> {
    const all: CheckId[] = [
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
      "a2aAgentCard",
      "agentSkills",
      "webMcp",
      "x402",
      "mpp",
      "ucp",
      "acp",
      "ap2",
    ];
    const r: Partial<Record<CheckId, CheckResult>> = {};
    for (const id of all) {
      r[id] = passing.includes(id) ? pass() : fail();
    }
    return r as Record<CheckId, CheckResult>;
  }

  it("L0 when nothing passes", () => {
    const out = determineLevel(makeResults([]));
    expect(out.level).toBe(0);
    expect(out.levelName).toBe("Not Ready");
    expect(out.nextLevel?.level).toBe(1);
    expect(out.nextLevel?.requirements).toEqual(
      expect.arrayContaining(["robotsTxt", "sitemap"]),
    );
  });

  it("L1 when robots + sitemap pass", () => {
    const out = determineLevel(makeResults(["robotsTxt", "sitemap"]));
    expect(out.level).toBe(1);
    expect(out.levelName).toBe("Basic Web Presence");
    expect(out.nextLevel?.level).toBe(2);
    expect(out.nextLevel?.requirements).toEqual(
      expect.arrayContaining(["robotsTxtAiRules", "contentSignals"]),
    );
  });

  it("L2 when bot-aware adds rules + signals", () => {
    const out = determineLevel(
      makeResults([
        "robotsTxt",
        "sitemap",
        "robotsTxtAiRules",
        "contentSignals",
      ]),
    );
    expect(out.level).toBe(2);
    expect(out.nextLevel?.requirements).toEqual(["markdownNegotiation"]);
  });

  it("L3 when agent-readable adds markdownNegotiation", () => {
    const out = determineLevel(
      makeResults([
        "robotsTxt",
        "sitemap",
        "robotsTxtAiRules",
        "contentSignals",
        "markdownNegotiation",
      ]),
    );
    expect(out.level).toBe(3);
    expect(out.nextLevel?.requirements).toEqual(
      expect.arrayContaining(["linkHeaders", "agentSkills"]),
    );
  });

  it("L4 when agent-integrated adds linkHeaders + agentSkills", () => {
    const out = determineLevel(
      makeResults([
        "robotsTxt",
        "sitemap",
        "robotsTxtAiRules",
        "contentSignals",
        "markdownNegotiation",
        "linkHeaders",
        "agentSkills",
      ]),
    );
    expect(out.level).toBe(4);
    expect(out.nextLevel?.level).toBe(5);
    expect(out.nextLevel?.requirements).toEqual(
      expect.arrayContaining([
        "apiCatalog",
        "oauthProtectedResource",
        "mcpServerCard",
        "a2aAgentCard",
      ]),
    );
  });

  it("L5 when every L5 requirement passes", () => {
    const out = determineLevel(
      makeResults([
        "robotsTxt",
        "sitemap",
        "robotsTxtAiRules",
        "contentSignals",
        "markdownNegotiation",
        "linkHeaders",
        "agentSkills",
        "apiCatalog",
        "oauthProtectedResource",
        "mcpServerCard",
        "a2aAgentCard",
      ]),
    );
    expect(out.level).toBe(5);
    expect(out.levelName).toBe("Agent-Native");
    expect(out.nextLevel).toBeNull();
  });
});
