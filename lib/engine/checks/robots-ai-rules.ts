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
  type ScanContext,
} from "@/lib/engine/context";
import type { CheckResult, EvidenceStep } from "@/lib/schema";
import { AI_BOT_TOKENS, buildFailNoRobots } from "./_shared";

const FETCH_LABEL = "GET /robots.txt";
const PARSE_LABEL = "Scan for AI bot User-agent directives";
const CONCLUDE_LABEL = "Conclusion";

const PASS_WILDCARD_MESSAGE =
  "No AI-specific bot rules; wildcard rules apply to all crawlers including AI bots";
const PASS_AI_FOUND_MESSAGE = "AI bot rules found in robots.txt";
const FAIL_NO_ROBOTS_MESSAGE = "Cannot check AI rules without robots.txt";

function extractUserAgents(body: string): Set<string> {
  const found = new Set<string>();
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.split("#")[0]!.trim();
    if (line.length === 0) continue;
    const match = /^user-agent\s*:\s*(.+)$/i.exec(line);
    if (match) {
      // RFC 9309 strictly specifies one product-token per User-agent line,
      // but it is common in the wild to see comma- or whitespace-separated
      // lists (e.g. `User-agent: GPTBot, ChatGPT-User`). We accept either
      // form and register each token independently. This intentionally goes
      // beyond RFC 9309 for pragmatic real-world coverage.
      const tokens = match[1]!.split(/[\s,]+/);
      for (const tok of tokens) {
        const norm = tok.trim().toLowerCase();
        if (norm.length > 0) found.add(norm);
      }
    }
  }
  return found;
}

function findAiBots(userAgents: Set<string>): string[] {
  return AI_BOT_TOKENS.filter((bot) => userAgents.has(bot));
}

export async function checkRobotsTxtAiRules(
  ctx: ScanContext,
): Promise<CheckResult> {
  const started = Date.now();
  const outcome = await ctx.getRobotsTxt();

  if (outcome.response === undefined || outcome.response.status !== 200) {
    return buildFailNoRobots({
      outcome,
      startedAt: started,
      fetchLabel: FETCH_LABEL,
      concludeLabel: CONCLUDE_LABEL,
      failMessage: FAIL_NO_ROBOTS_MESSAGE,
    });
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
        checkedBots: [...AI_BOT_TOKENS],
        foundBots,
      },
      evidence,
      durationMs: Date.now() - started,
    };
  }

  evidence.push(
    makeStep("parse", PARSE_LABEL, {
      outcome: "positive",
      summary: `Checked ${AI_BOT_TOKENS.length} AI bot user agents -- none found, but wildcard rules apply`,
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
    details: { checkedBots: [...AI_BOT_TOKENS] },
    evidence,
    durationMs: Date.now() - started,
  };
}
