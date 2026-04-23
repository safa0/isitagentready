/**
 * Commerce check: `ucp` (Universal Commerce Protocol).
 *
 * Reference: FINDINGS §3 + §9. Spec: https://ucp.dev/.
 *
 * Fetch plan: `GET /.well-known/ucp`.
 * Pass iff 200 + JSON body containing all four required fields:
 *   - `protocol_version`
 *   - `services`
 *   - `capabilities`
 *   - `endpoints`
 */

import {
  fetchToStep,
  makeStep,
  type ScanContext,
  type FetchOutcome,
} from "@/lib/engine/context";
import type { CheckResult, EvidenceStep } from "@/lib/schema";
import { applyCommerceGate } from "@/lib/engine/commerce-signals";

const FETCH_LABEL = "GET /.well-known/ucp";
const CONCLUDE_LABEL = "Conclusion";

const PASS_MESSAGE = "UCP profile found";
const FAIL_MESSAGE = "UCP profile not found";

const REQUIRED_FIELDS = [
  "protocol_version",
  "services",
  "capabilities",
  "endpoints",
] as const;

function evaluate(outcome: FetchOutcome): {
  pass: boolean;
  summary: string;
  verdict: "positive" | "negative";
} {
  if (outcome.response === undefined) {
    return {
      pass: false,
      verdict: "negative",
      summary: `UCP request failed: ${outcome.error ?? "no response"}`,
    };
  }
  const status = outcome.response.status;
  if (status !== 200) {
    return {
      pass: false,
      verdict: "negative",
      summary: `Server returned ${status} -- UCP profile not found`,
    };
  }
  const body = outcome.body ?? "";
  try {
    const parsed = JSON.parse(body);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        pass: false,
        verdict: "negative",
        summary: "UCP profile body is not a JSON object",
      };
    }
    const obj = parsed as Record<string, unknown>;
    const missing = REQUIRED_FIELDS.filter(
      (f) => !Object.prototype.hasOwnProperty.call(obj, f),
    );
    if (missing.length > 0) {
      return {
        pass: false,
        verdict: "negative",
        summary: `UCP profile missing required field(s): ${missing.join(", ")}`,
      };
    }
    return {
      pass: true,
      verdict: "positive",
      summary: "UCP profile contains all required fields",
    };
  } catch {
    return {
      pass: false,
      verdict: "negative",
      summary: "UCP profile response is not valid JSON",
    };
  }
}

export async function checkUcp(
  ctx: ScanContext,
): Promise<CheckResult> {
  const started = Date.now();
  const outcome = await ctx.fetch("/.well-known/ucp");
  const verdict = evaluate(outcome);

  const evidence: EvidenceStep[] = [];
  evidence.push(
    fetchToStep(outcome, FETCH_LABEL, {
      outcome: verdict.verdict,
      summary: verdict.summary,
    }),
  );

  if (verdict.pass) {
    evidence.push(
      makeStep("conclude", CONCLUDE_LABEL, {
        outcome: "positive",
        summary: PASS_MESSAGE,
      }),
    );
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

  evidence.push(
    makeStep("conclude", CONCLUDE_LABEL, {
      outcome: "negative",
      summary: FAIL_MESSAGE,
    }),
  );
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
