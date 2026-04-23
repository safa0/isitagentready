/**
 * Discovery check: `a2aAgentCard`.
 *
 * Specification
 * -------------
 * - GET `/.well-known/agent-card.json` on the origin.
 * - Pass iff the response is 200 AND the body parses as JSON AND contains at
 *   least `{ name: string, version: string, skills: [non-empty array] }` per
 *   FINDINGS §3 and the task specification.
 * - Fail on 404, transport error, non-JSON body, missing required fields,
 *   or an empty skills array.
 *
 * NOTE (FINDINGS §9 divergence): FINDINGS §9 phrases the pass predicate in
 *   terms of `supportedInterfaces`. This implementation intentionally follows
 *   FINDINGS §3 + the task brief + skill-a2a-agent-card.md and uses
 *   `{ name, version, skills: non-empty[] }` as the pass predicate. Treat the
 *   §9 wording as a doc bug — the skill/task contract is authoritative.
 *
 * NOTE: this check is reported regardless of the user's enabledChecks opt-in
 * status — the scoring layer is responsible for excluding it from the
 * denominator when the user hasn't opted in. FINDINGS §13 pt. 4.
 *
 * Evidence timeline
 * -----------------
 * - Fail (404 / transport): fetch -> conclude.
 * - Fail (invalid JSON): fetch -> validate (JSON parse) -> conclude.
 * - Fail (missing fields): fetch -> validate (JSON parse) -> validate (shape) -> conclude.
 * - Pass:                  fetch -> validate (JSON parse) -> validate (shape) -> conclude.
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

const AGENT_CARD_PATH = "/.well-known/agent-card.json";
const FETCH_LABEL = "GET /.well-known/agent-card.json";
const PARSE_JSON_LABEL = "Parse agent-card.json";
const VALIDATE_SHAPE_LABEL = "Validate A2A agent card shape";
const CONCLUDE_LABEL = "Conclusion";

const FAIL_NOT_FOUND_MESSAGE = "A2A Agent Card not found";
const FAIL_INVALID_JSON_MESSAGE = "A2A Agent Card is not valid JSON";
const FAIL_INVALID_SHAPE_MESSAGE =
  "A2A Agent Card is missing required fields (name, version, skills)";
const PASS_MESSAGE = "A2A Agent Card is valid";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AgentCardShape {
  readonly name: string;
  readonly version: string;
  readonly skills: readonly unknown[];
}

function hasValidCardShape(value: unknown): value is AgentCardShape {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.name !== "string" || obj.name.length === 0) return false;
  if (typeof obj.version !== "string" || obj.version.length === 0) return false;
  if (!Array.isArray(obj.skills) || obj.skills.length === 0) return false;
  return true;
}

function buildFetchFailStep(outcome: FetchOutcome): EvidenceStep {
  if (outcome.response === undefined) {
    return fetchToStep(outcome, FETCH_LABEL, {
      outcome: "negative",
      summary: outcome.error
        ? `Transport error fetching agent-card.json: ${outcome.error}`
        : "Transport error fetching agent-card.json",
    });
  }
  return fetchToStep(outcome, FETCH_LABEL, {
    outcome: "negative",
    summary: `Server returned ${outcome.response.status} -- A2A Agent Card not found`,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function checkA2aAgentCard(
  ctx: ScanContext,
): Promise<CheckResult> {
  const started = Date.now();
  const outcome = await ctx.fetch(AGENT_CARD_PATH);

  // 1. Fetch failure or non-200 response.
  if (outcome.response === undefined || outcome.response.status !== 200) {
    const evidence: EvidenceStep[] = [
      buildFetchFailStep(outcome),
      makeStep("conclude", CONCLUDE_LABEL, {
        outcome: "negative",
        summary: FAIL_NOT_FOUND_MESSAGE,
      }),
    ];
    return {
      status: "fail",
      message: FAIL_NOT_FOUND_MESSAGE,
      evidence,
      durationMs: Date.now() - started,
    };
  }

  // 2. Attempt to parse JSON body.
  const fetchStep = fetchToStep(outcome, FETCH_LABEL, {
    outcome: "positive",
    summary: `Received 200 response with content-type: ${
      outcome.response.headers["content-type"] ?? "unknown"
    }`,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.body ?? "");
  } catch (err) {
    const parseErr = err instanceof Error ? err.message : String(err);
    const evidence: EvidenceStep[] = [
      fetchStep,
      makeStep("validate", PARSE_JSON_LABEL, {
        outcome: "negative",
        summary: `Failed to parse JSON body: ${parseErr}`,
      }),
      makeStep("conclude", CONCLUDE_LABEL, {
        outcome: "negative",
        summary: FAIL_INVALID_JSON_MESSAGE,
      }),
    ];
    return {
      status: "fail",
      message: FAIL_INVALID_JSON_MESSAGE,
      evidence,
      durationMs: Date.now() - started,
    };
  }

  // 3. Validate shape.
  const parseStep = makeStep("validate", PARSE_JSON_LABEL, {
    outcome: "positive",
    summary: "agent-card.json parsed as valid JSON",
  });

  if (!hasValidCardShape(parsed)) {
    const evidence: EvidenceStep[] = [
      fetchStep,
      parseStep,
      makeStep("validate", VALIDATE_SHAPE_LABEL, {
        outcome: "negative",
        summary:
          "Missing one or more required fields: name (string), version (string), skills (non-empty array)",
      }),
      makeStep("conclude", CONCLUDE_LABEL, {
        outcome: "negative",
        summary: FAIL_INVALID_SHAPE_MESSAGE,
      }),
    ];
    return {
      status: "fail",
      message: FAIL_INVALID_SHAPE_MESSAGE,
      evidence,
      durationMs: Date.now() - started,
    };
  }

  // 4. Pass.
  const evidence: EvidenceStep[] = [
    fetchStep,
    parseStep,
    makeStep("validate", VALIDATE_SHAPE_LABEL, {
      outcome: "positive",
      summary: `Card declares ${parsed.skills.length} skill(s)`,
    }),
    makeStep("conclude", CONCLUDE_LABEL, {
      outcome: "positive",
      summary: PASS_MESSAGE,
    }),
  ];

  return {
    status: "pass",
    message: PASS_MESSAGE,
    details: {
      name: parsed.name,
      version: parsed.version,
      skillCount: parsed.skills.length,
    },
    evidence,
    durationMs: Date.now() - started,
  };
}
