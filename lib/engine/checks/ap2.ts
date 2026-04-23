/**
 * Commerce check: `ap2` (Agent Payments Protocol v2).
 *
 * Reference: FINDINGS §3 + §9 + §13 (Gap #5). AP2 has no public SKILL.md;
 * the reference scanner derives its verdict entirely from the A2A Agent
 * Card result — AP2 is "present" iff the A2A Agent Card passes AND declares
 * an AP2-compatible skill.
 *
 * Dependency wiring — Option A (per impl-E instructions)
 * -------------------------------------------------------
 * To avoid a file-ownership circular dependency between this check
 * (owned by impl-E) and `a2a-agent-card.ts` (owned by impl-C), we accept
 * the prior check's `CheckResult` as a function parameter. The orchestrator
 * (Phase 3) is responsible for running `a2aAgentCard` first and passing
 * its result in. `null` is accepted (e.g. when the user has opted out of
 * the a2a check, or when the orchestrator has not yet been wired) — in
 * that case AP2 reports the same "no A2A Agent Card" verdict as a failing
 * a2a result, matching both shopify and vercel oracles which record an
 * absent card.
 *
 * Commerce gating mirrors the other commerce checks: when `isCommerce` is
 * false, the top-level status is forced to "neutral" and
 * " (not a commerce site)" is appended to the message. The inner evidence
 * and conclusion finding are preserved verbatim.
 */

import { makeStep, type ScanContext } from "@/lib/engine/context";
import type { CheckResult, EvidenceStep } from "@/lib/schema";
import { applyCommerceGate } from "@/lib/engine/commerce-signals";

const CONCLUDE_LABEL = "Conclusion";

const FAIL_MESSAGE = "AP2 not detected (no A2A Agent Card)";
const FAIL_NO_CARD_SUMMARY =
  "No A2A Agent Card found -- AP2 requires an A2A Agent Card";

const FAIL_NO_SKILL_MESSAGE = "AP2 not detected (no AP2-compatible skill)";
const FAIL_NO_SKILL_SUMMARY =
  "A2A Agent Card found but no AP2-compatible skill declared";

const PASS_MESSAGE = "AP2 detected via A2A Agent Card";
const PASS_SUMMARY =
  "A2A Agent Card declares an AP2-compatible skill";

/**
 * AP2-compatible skill tokens. Any A2A Agent Card skill id (or key) that
 * contains one of these substrings (case-insensitive) counts as AP2
 * advertisement. We intentionally keep this list tight — AP2 draft doesn't
 * mandate an exact id yet, but broader tokens like "commerce" or "purchase"
 * over-match skills such as "commerce-reports" or unrelated commerce tooling.
 * The literal "ap2" prefix plus "payment(s)" and "checkout" are specific
 * enough to minimise false positives while still catching the obvious
 * advertisements FINDINGS §3 describes.
 */
const AP2_SKILL_TOKENS = [
  "ap2",
  "payment",
  "payments",
  "checkout",
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SkillLike {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly key?: unknown;
}

function extractSkillTokens(details: unknown): string[] {
  if (details === null || typeof details !== "object") return [];
  const obj = details as Record<string, unknown>;
  const skills = obj["skills"];
  if (!Array.isArray(skills)) return [];
  const tokens: string[] = [];
  for (const skill of skills) {
    if (typeof skill === "string") {
      tokens.push(skill.toLowerCase());
      continue;
    }
    if (skill !== null && typeof skill === "object") {
      const s = skill as SkillLike;
      for (const cand of [s.id, s.name, s.key]) {
        if (typeof cand === "string") tokens.push(cand.toLowerCase());
      }
    }
  }
  return tokens;
}

function hasAp2Skill(tokens: readonly string[]): boolean {
  for (const token of tokens) {
    for (const ap2 of AP2_SKILL_TOKENS) {
      if (token.includes(ap2)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function checkAp2(ctx: ScanContext): Promise<CheckResult> {
  const started = Date.now();

  const a2a = ctx.a2aAgentCard;

  // When the orchestrator didn't run the a2a check (caller excluded it or
  // it is opt-in-by-default), AP2 cannot truthfully claim a negative — we
  // just didn't look. Emit a neutral "skipped" verdict so scoring and
  // level gates don't count this against the site.
  if (a2a === null && !ctx.a2aAgentCardEnabled) {
    const skippedMessage = "Skipped: requires a2aAgentCard to be enabled.";
    const evidence: EvidenceStep[] = [
      makeStep("conclude", CONCLUDE_LABEL, {
        outcome: "neutral",
        summary: skippedMessage,
      }),
    ];
    // The commerce gate would force neutral + a site suffix, but "skipped"
    // is already the right answer regardless of isCommerce.
    return {
      status: "neutral",
      message: skippedMessage,
      evidence,
      durationMs: Date.now() - started,
    };
  }

  const cardMissing = a2a === null || a2a.status !== "pass";

  if (cardMissing) {
    const evidence: EvidenceStep[] = [
      makeStep("conclude", CONCLUDE_LABEL, {
        outcome: "negative",
        summary: FAIL_NO_CARD_SUMMARY,
      }),
    ];
    return applyCommerceGate(
      {
        status: "fail",
        message: FAIL_MESSAGE,
        evidence,
        durationMs: Date.now() - started,
      },
      ctx.isCommerce,
    );
  }

  const tokens = extractSkillTokens(a2a.details);
  if (!hasAp2Skill(tokens)) {
    const evidence: EvidenceStep[] = [
      makeStep("conclude", CONCLUDE_LABEL, {
        outcome: "negative",
        summary: FAIL_NO_SKILL_SUMMARY,
      }),
    ];
    return applyCommerceGate(
      {
        status: "fail",
        message: FAIL_NO_SKILL_MESSAGE,
        evidence,
        durationMs: Date.now() - started,
      },
      ctx.isCommerce,
    );
  }

  const evidence: EvidenceStep[] = [
    makeStep("conclude", CONCLUDE_LABEL, {
      outcome: "positive",
      summary: PASS_SUMMARY,
    }),
  ];
  return applyCommerceGate(
    {
      status: "pass",
      message: PASS_MESSAGE,
      evidence,
      durationMs: Date.now() - started,
    },
    ctx.isCommerce,
  );
}
