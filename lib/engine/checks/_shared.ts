/**
 * Cross-check shared helpers: JSON parsing, robots fetch-failure plumbing,
 * AI bot token list.
 *
 * Not part of the public engine API — intentionally prefixed with `_` to
 * signal that. `tryParseJson` is consumed by the Phase-2 JSON-probing checks
 * (api-catalog, oauth-discovery, oauth-protected-resource, mcp-server-card),
 * while `buildFailNoRobots` and `AI_BOT_TOKENS` are consumed by the
 * robots.txt-dependent checks (robotsTxtAiRules, contentSignals).
 */

import {
  fetchToStep,
  makeStep,
  type FetchOutcome,
} from "@/lib/engine/context";
import type { CheckResult, EvidenceStep } from "@/lib/schema";

/**
 * Best-effort JSON parse — returns `undefined` on empty input or parse error.
 * Lifted here from the per-check duplicates so every JSON-probing check
 * shares a single implementation.
 */
export function tryParseJson(body: string | undefined): unknown | undefined {
  if (body === undefined || body.length === 0) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

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
