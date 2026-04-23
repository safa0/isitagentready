/**
 * Check: robotsTxtAiRules (category: botAccessControl).
 *
 * Re-uses the scan context's memoised /robots.txt fetch (shared with the
 * robotsTxt and contentSignals checks). Parses User-agent groups and looks
 * for explicit rules for well-known AI crawlers.
 *
 * Verdict rules, derived from research/raw/*.json oracles:
 * - Transport error / non-200 response -> fail ("Cannot check AI rules without
 *   robots.txt")
 * - 200 + at least one AI-specific User-agent group -> pass ("AI bot rules
 *   found in robots.txt")
 * - 200 + no AI-specific User-agent groups -> pass ("No AI-specific bot rules;
 *   wildcard rules apply to all crawlers including AI bots")
 */

import {
  fetchToStep,
  makeStep,
  type FetchOutcome,
  type ScanContext,
} from "@/lib/engine/context";
import type { CheckResult, EvidenceStep } from "@/lib/schema";

const FETCH_LABEL = "GET /robots.txt";
const PARSE_LABEL = "Scan for AI bot User-agent directives";
const CONCLUDE_LABEL = "Conclusion";

const PASS_WILDCARD_MESSAGE =
  "No AI-specific bot rules; wildcard rules apply to all crawlers including AI bots";
const PASS_AI_FOUND_MESSAGE = "AI bot rules found in robots.txt";
const FAIL_NO_ROBOTS_MESSAGE = "Cannot check AI rules without robots.txt";

/**
 * Canonical (lowercase) list of AI crawler user-agent tokens probed for in
 * robots.txt User-agent lines. Order is preserved in details.checkedBots.
 * Matches the 15 bots enumerated in the Cloudflare oracle fixtures.
 */
const AI_BOTS: readonly string[] = [
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
];

function extractUserAgents(body: string): Set<string> {
  const found = new Set<string>();
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.split("#")[0]!.trim();
    if (line.length === 0) continue;
    const match = /^user-agent\s*:\s*(.+)$/i.exec(line);
    if (match) {
      found.add(match[1]!.trim().toLowerCase());
    }
  }
  return found;
}

function findAiBots(userAgents: Set<string>): string[] {
  return AI_BOTS.filter((bot) => userAgents.has(bot));
}

function buildFailNoRobots(
  outcome: FetchOutcome,
  startedAt: number,
): CheckResult {
  const evidence: EvidenceStep[] = [];
  const fetchFinding =
    outcome.response === undefined
      ? {
          outcome: "negative" as const,
          summary: `Transport error fetching robots.txt: ${outcome.error ?? "unknown"}`,
        }
      : {
          outcome: "negative" as const,
          summary: `Server returned ${outcome.response.status} -- robots.txt not found`,
        };

  evidence.push(fetchToStep(outcome, FETCH_LABEL, fetchFinding));
  evidence.push(
    makeStep("conclude", CONCLUDE_LABEL, {
      outcome: "negative",
      summary: FAIL_NO_ROBOTS_MESSAGE,
    }),
  );

  return {
    status: "fail",
    message: FAIL_NO_ROBOTS_MESSAGE,
    evidence,
    durationMs: Date.now() - startedAt,
  };
}

export async function checkRobotsTxtAiRules(
  ctx: ScanContext,
): Promise<CheckResult> {
  const started = Date.now();
  const outcome = await ctx.getRobotsTxt();

  if (outcome.response === undefined || outcome.response.status !== 200) {
    return buildFailNoRobots(outcome, started);
  }

  const contentType = outcome.response.headers["content-type"] ?? "unknown";
  const body = outcome.body ?? "";
  const userAgents = extractUserAgents(body);
  const foundBots = findAiBots(userAgents);

  const evidence: EvidenceStep[] = [];
  evidence.push(
    fetchToStep(outcome, FETCH_LABEL, {
      outcome: "positive",
      summary: `Received valid robots.txt (${outcome.response.status}, ${contentType})`,
    }),
  );

  if (foundBots.length > 0) {
    evidence.push(
      makeStep("parse", PARSE_LABEL, {
        outcome: "positive",
        summary: `Found ${foundBots.length} AI-specific User-agent directive(s): ${foundBots.join(", ")}`,
      }),
    );
    evidence.push(
      makeStep("conclude", CONCLUDE_LABEL, {
        outcome: "positive",
        summary: PASS_AI_FOUND_MESSAGE,
      }),
    );
    return {
      status: "pass",
      message: PASS_AI_FOUND_MESSAGE,
      details: {
        checkedBots: [...AI_BOTS],
        foundBots,
      },
      evidence,
      durationMs: Date.now() - started,
    };
  }

  evidence.push(
    makeStep("parse", PARSE_LABEL, {
      outcome: "positive",
      summary: `Checked ${AI_BOTS.length} AI bot user agents -- none found, but wildcard rules apply`,
    }),
  );
  evidence.push(
    makeStep("conclude", CONCLUDE_LABEL, {
      outcome: "positive",
      summary: PASS_WILDCARD_MESSAGE,
    }),
  );

  return {
    status: "pass",
    message: PASS_WILDCARD_MESSAGE,
    details: { checkedBots: [...AI_BOTS] },
    evidence,
    durationMs: Date.now() - started,
  };
}
