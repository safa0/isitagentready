/**
 * Failing specs for the `ap2` commerce check.
 *
 * Reference: FINDINGS §3 + §9 + §13 (Gap #5).
 * Oracle: research/raw/scan-*.json → checks.commerce.ap2
 *
 * AP2 has no direct probe. Its verdict is derived from the a2aAgentCard
 * result carried on the `ScanContext`. When `ctx.a2aAgentCard === null`
 * (card not yet computed or opt-out), the check reports the same
 * "no A2A Agent Card" conclusion as a failing a2a result — this mirrors
 * the shopify / vercel oracles, which both record a missing card.
 *
 * isCommerce gating: same as the other commerce checks — when
 * `ctx.isCommerce === false`, status is forced to "neutral" and
 * " (not a commerce site)" is appended to the message. The conclusion
 * finding summary is preserved verbatim.
 */

import { describe, it, expect } from "vitest";

import { CheckResultSchema, type CheckResult } from "@/lib/schema";
import { checkAp2 } from "@/lib/engine/checks/ap2";
import { createScanContext } from "@/lib/engine/context";
import { ALL_SITES, loadOracle } from "./_helpers/oracle";

// ---------------------------------------------------------------------------
// A2A card fixtures — mimic the CheckResult the a2a-agent-card check would
// produce. We deliberately do NOT import the real check here; impl-E must
// not depend on impl-C.
// ---------------------------------------------------------------------------

function a2aFail(): CheckResult {
  return {
    status: "fail",
    message: "A2A Agent Card not found",
    evidence: [
      {
        action: "conclude",
        label: "Conclusion",
        finding: { outcome: "negative", summary: "A2A Agent Card not found" },
      },
    ],
    durationMs: 1,
  };
}

function a2aPassWithSkill(skills: string[]): CheckResult {
  return {
    status: "pass",
    message: "A2A Agent Card found",
    details: {
      name: "Shop",
      version: "1.0",
      skills: skills.map((id) => ({ id })),
    },
    evidence: [
      {
        action: "conclude",
        label: "Conclusion",
        finding: { outcome: "positive", summary: "A2A Agent Card found" },
      },
    ],
    durationMs: 1,
  };
}

const NOOP_FETCH: typeof fetch = async () =>
  new Response("", { status: 404 });

function ctxWith(opts: {
  readonly isCommerce: boolean;
  readonly a2aAgentCard: CheckResult | null;
  readonly a2aAgentCardEnabled?: boolean;
}) {
  return createScanContext({
    url: "https://example.test",
    fetchImpl: NOOP_FETCH,
    isCommerce: opts.isCommerce,
    a2aAgentCard: opts.a2aAgentCard,
    // Default to `true` so the legacy "a2a=null ⇒ fail" tests still exercise
    // the "we looked and nothing came back" path. New specs set this
    // explicitly to `false` to exercise the skipped semantics.
    a2aAgentCardEnabled: opts.a2aAgentCardEnabled ?? true,
  });
}

// ---------------------------------------------------------------------------
// Shopify / commerce oracle round-trip
// ---------------------------------------------------------------------------

describe("ap2 — shopify oracle (isCommerce=true)", () => {
  it("fails with a single conclude step when no A2A card is available", async () => {
    const result = await checkAp2(
      ctxWith({ isCommerce: true, a2aAgentCard: a2aFail() }),
    );

    expect(CheckResultSchema.safeParse(result).success).toBe(true);
    expect(result.status).toBe("fail");
    expect(result.message).toBe("AP2 not detected (no A2A Agent Card)");
    expect(result.evidence).toHaveLength(1);
    const step = result.evidence[0];
    expect(step).toBeDefined();
    expect(step?.action).toBe("conclude");
    expect(step?.finding).toEqual({
      outcome: "negative",
      summary: "No A2A Agent Card found -- AP2 requires an A2A Agent Card",
    });
  });

  it("fails with the same conclusion when the a2a result is null (not yet computed)", async () => {
    const result = await checkAp2(
      ctxWith({ isCommerce: true, a2aAgentCard: null }),
    );
    expect(result.status).toBe("fail");
    expect(result.message).toBe("AP2 not detected (no A2A Agent Card)");
  });

  it("passes when the A2A card advertises an AP2-compatible commerce skill", async () => {
    const result = await checkAp2(
      ctxWith({
        isCommerce: true,
        a2aAgentCard: a2aPassWithSkill(["ap2.payments", "catalog"]),
      }),
    );
    expect(result.status).toBe("pass");
    expect(result.message).toMatch(/AP2/i);
  });

  it("fails when the A2A card passes but declares no commerce-related skill", async () => {
    const result = await checkAp2(
      ctxWith({
        isCommerce: true,
        a2aAgentCard: a2aPassWithSkill(["weather", "support"]),
      }),
    );
    expect(result.status).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// Non-commerce gating
// ---------------------------------------------------------------------------

describe("ap2 — gating across origins", () => {
  it.each(ALL_SITES)(
    "matches the oracle status + message for %s",
    async (site) => {
      const fixture = loadOracle(site);
      const oracle = fixture.raw.checks.commerce.ap2;
      const isCommerce = Boolean(fixture.raw.isCommerce);
      // All 5 oracles record a missing A2A card, so we pass `null`.
      const result = await checkAp2(
        ctxWith({ isCommerce, a2aAgentCard: null }),
      );
      expect(result.status).toBe(oracle.status);
      expect(result.message).toBe(oracle.message);
    },
  );
});

describe("ap2 — a2aAgentCard not enabled", () => {
  it("reports neutral/skipped when a2a is not enabled and no card is supplied", async () => {
    const result = await checkAp2(
      ctxWith({
        isCommerce: true,
        a2aAgentCard: null,
        a2aAgentCardEnabled: false,
      }),
    );
    expect(result.status).toBe("neutral");
    expect(result.message).toMatch(/Skipped: requires a2aAgentCard/);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.finding.outcome).toBe("neutral");
  });

  it("does not append the commerce-site suffix to the skipped message", async () => {
    const result = await checkAp2(
      ctxWith({
        isCommerce: false,
        a2aAgentCard: null,
        a2aAgentCardEnabled: false,
      }),
    );
    expect(result.status).toBe("neutral");
    expect(result.message).not.toMatch(/not a commerce site/);
  });
});

describe("ap2 — non-commerce gating", () => {
  it("returns neutral with suffix when the site is not commerce", async () => {
    const result = await checkAp2(
      ctxWith({ isCommerce: false, a2aAgentCard: null }),
    );
    expect(result.status).toBe("neutral");
    expect(result.message).toBe(
      "AP2 not detected (no A2A Agent Card) (not a commerce site)",
    );
    const step = result.evidence[0];
    expect(step).toBeDefined();
    expect(step?.finding.summary).toBe(
      "No A2A Agent Card found -- AP2 requires an A2A Agent Card",
    );
  });

  it("keeps the pass-path conclusion when a2a passes but site is not commerce", async () => {
    const result = await checkAp2(
      ctxWith({
        isCommerce: false,
        a2aAgentCard: a2aPassWithSkill(["ap2.payments"]),
      }),
    );
    expect(result.status).toBe("neutral");
    expect(result.message).toMatch(/not a commerce site/);
  });
});
