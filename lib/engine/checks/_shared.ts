/**
 * Internal helpers shared by the robots.txt-dependent checks that live in
 * this directory (robotsTxtAiRules, contentSignals). Not part of the public
 * engine API — intentionally prefixed with `_` to signal that.
 *
 * If more checks elsewhere in the codebase later need to depend on robots.txt
 * fetch-failure plumbing, promote this module up one level.
 */

import {
  fetchToStep,
  makeStep,
  type FetchOutcome,
} from "@/lib/engine/context";
import type { CheckResult, EvidenceStep } from "@/lib/schema";

/**
 * Canonical (lowercase) list of AI crawler user-agent tokens probed for in
 * robots.txt User-agent lines. Exported so sibling checks can reuse the same
 * set without redeclaring it. Frozen `as const` to make the intent
 * (read-only, reuse-only) explicit at the type level.
 */
export const AI_BOT_TOKENS = [
  "gptbot",
  "chatgpt-user",
  "google-extended",
  "ccbot",
  "anthropic-ai",
  "claude-web",
  "bytespider",
  "perplexitybot",
  "cohere-ai",
  "applebot-extended",
  "amazonbot",
  "meta-externalagent",
  "facebookbot",
  "omgilibot",
  "diffbot",
] as const;

export type AiBotToken = (typeof AI_BOT_TOKENS)[number];

/**
 * Build a standard "fail because robots.txt is unavailable" CheckResult.
 *
 * Shared between robotsTxtAiRules and contentSignals — both behave the same
 * way when the /robots.txt fetch fails: a single fetch step with negative
 * finding plus a conclusion step carrying `failMessage`.
 */
export function buildFailNoRobots(params: {
  outcome: FetchOutcome;
  startedAt: number;
  fetchLabel: string;
  concludeLabel: string;
  failMessage: string;
}): CheckResult {
  const { outcome, startedAt, fetchLabel, concludeLabel, failMessage } = params;
  const evidence: EvidenceStep[] = [];
  const fetchFinding =
    outcome.response === undefined
      ? {
          outcome: "negative" as const,
          summary: `Transport error fetching robots.txt: ${outcome.error}`,
        }
      : {
          outcome: "negative" as const,
          summary: `Server returned ${outcome.response.status} -- robots.txt not found`,
        };

  evidence.push(fetchToStep(outcome, fetchLabel, fetchFinding));
  evidence.push(
    makeStep("conclude", concludeLabel, {
      outcome: "negative",
      summary: failMessage,
    }),
  );

  return {
    status: "fail",
    message: failMessage,
    evidence,
    durationMs: Date.now() - startedAt,
  };
}
