/**
 * Discoverability check: `robotsTxt`.
 *
 * Specification
 * -------------
 * - Probe: `GET /robots.txt` (single network call, memoised via ctx).
 * - Pass criteria (FINDINGS §9):
 *   1. HTTP 200 response.
 *   2. `Content-Type` begins with `text/plain` (rules out soft-404 HTML).
 *   3. Body contains at least one `User-agent:` directive (case-insensitive).
 *
 * Evidence timeline
 * -----------------
 * - Success path: `fetch → parse → conclude` (matching the oracle fixtures).
 * - Failure path (4xx/5xx, HTML, transport error): `fetch → conclude`.
 *
 * The check never throws; every branch produces a validatable `CheckResult`.
 */

import type { CheckResult, EvidenceStep } from "@/lib/schema";
import {
  fetchToStep,
  makeStep,
  type FetchOutcome,
  type ScanContext,
} from "@/lib/engine/context";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONCLUDE_LABEL = "Conclusion";
const VALIDATE_LABEL = "Validate robots.txt structure";
const FETCH_LABEL = "GET /robots.txt";

const PASS_MESSAGE = "robots.txt exists with valid format";
const NOT_FOUND_MESSAGE = "robots.txt not found";
const NOT_FOUND_CONCLUDE_SUMMARY =
  "robots.txt not found (404, soft-404, or HTML response)";

/** Matches `User-agent:` directive at the start of a line (case-insensitive). */
const USER_AGENT_DIRECTIVE = /^\s*user-agent\s*:/im;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasPlainTextContentType(
  headers: Record<string, string> | undefined,
): boolean {
  if (headers === undefined) return false;
  const ct = headers["content-type"] ?? "";
  return ct.toLowerCase().startsWith("text/plain");
}

function hasUserAgentDirective(body: string | undefined): boolean {
  if (body === undefined || body.length === 0) return false;
  return USER_AGENT_DIRECTIVE.test(body);
}

function failResult(
  evidence: readonly EvidenceStep[],
  message: string,
  durationMs: number,
): CheckResult {
  return {
    status: "fail",
    message,
    evidence: [...evidence],
    durationMs,
  };
}

function passResult(
  evidence: readonly EvidenceStep[],
  durationMs: number,
): CheckResult {
  return {
    status: "pass",
    message: PASS_MESSAGE,
    evidence: [...evidence],
    durationMs,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function checkRobotsTxt(ctx: ScanContext): Promise<CheckResult> {
  const started = Date.now();
  const outcome: FetchOutcome = await ctx.getRobotsTxt();

  // Transport error → record an unresponsive fetch step + a conclude step.
  if (outcome.response === undefined) {
    const fetchStep = fetchToStep(outcome, FETCH_LABEL, {
      outcome: "negative",
      summary: outcome.error
        ? `Request failed: ${outcome.error}`
        : "Request failed with no response",
    });
    const conclude = makeStep("conclude", CONCLUDE_LABEL, {
      outcome: "negative",
      summary: NOT_FOUND_CONCLUDE_SUMMARY,
    });
    return failResult(
      [fetchStep, conclude],
      NOT_FOUND_MESSAGE,
      Date.now() - started,
    );
  }

  const { response, body } = outcome;
  const ct = response.headers["content-type"] ?? "unknown";

  // Non-200 or HTML-ish response → fail immediately (no parse step).
  const looksLikeRobotsTxt =
    response.status === 200 && hasPlainTextContentType(response.headers);
  if (!looksLikeRobotsTxt) {
    const summary =
      response.status !== 200
        ? `Server returned ${response.status} -- robots.txt not found`
        : `Unexpected content-type ${ct} -- robots.txt not found`;
    const fetchStep = fetchToStep(outcome, FETCH_LABEL, {
      outcome: "negative",
      summary,
    });
    const conclude = makeStep("conclude", CONCLUDE_LABEL, {
      outcome: "negative",
      summary: NOT_FOUND_CONCLUDE_SUMMARY,
    });
    return failResult(
      [fetchStep, conclude],
      NOT_FOUND_MESSAGE,
      Date.now() - started,
    );
  }

  // 200 + text/plain. Record a positive fetch step, then validate structure.
  const fetchStep = fetchToStep(outcome, FETCH_LABEL, {
    outcome: "positive",
    summary: `Received valid robots.txt (200, ${ct})`,
  });

  const structured = hasUserAgentDirective(body);
  const parseStep = makeStep("parse", VALIDATE_LABEL, {
    outcome: structured ? "positive" : "negative",
    summary: structured
      ? "Contains valid User-agent directive(s)"
      : "No User-agent directive found",
  });

  if (!structured) {
    const conclude = makeStep("conclude", CONCLUDE_LABEL, {
      outcome: "negative",
      summary:
        "robots.txt returned 200 but does not contain a valid User-agent directive",
    });
    return failResult(
      [fetchStep, parseStep, conclude],
      "robots.txt missing required User-agent directive",
      Date.now() - started,
    );
  }

  const conclude = makeStep("conclude", CONCLUDE_LABEL, {
    outcome: "positive",
    summary: PASS_MESSAGE,
  });
  return passResult([fetchStep, parseStep, conclude], Date.now() - started);
}
