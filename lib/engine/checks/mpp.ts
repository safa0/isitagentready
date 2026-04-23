/**
 * Commerce check: `mpp` (Machine Payment Protocol).
 *
 * Reference: FINDINGS §3 + §9. Spec: https://mpp.dev/.
 *
 * Fetch plan: `GET /openapi.json`.
 * Pass iff:
 *   - response is 200, AND
 *   - body parses as JSON, AND
 *   - body contains an `x-payment-info` extension key anywhere — either at
 *     the root of the OpenAPI document or nested inside operations.
 *
 * HTML soft-404 responses (200 + `content-type: text/html`) fail with a
 * distinct summary matching the fixture oracle verbatim.
 */

import {
  fetchToStep,
  makeStep,
  type ScanContext,
  type FetchOutcome,
} from "@/lib/engine/context";
import type { CheckResult, EvidenceStep } from "@/lib/schema";
import { applyCommerceGate } from "@/lib/engine/commerce-signals";

const FETCH_LABEL = "GET /openapi.json";
const CONCLUDE_LABEL = "Conclusion";

const PASS_MESSAGE = "MPP payment discovery detected";
const FAIL_MESSAGE = "MPP payment discovery not detected";

function containsKeyDeep(value: unknown, key: string): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (containsKeyDeep(item, key)) return true;
    }
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return true;
  for (const v of Object.values(obj)) {
    if (containsKeyDeep(v, key)) return true;
  }
  return false;
}

function evaluate(outcome: FetchOutcome): {
  pass: boolean;
  summary: string;
  verdict: "positive" | "neutral" | "negative";
} {
  if (outcome.response === undefined) {
    return {
      pass: false,
      verdict: "neutral",
      summary: `/openapi.json request failed: ${outcome.error ?? "no response"}`,
    };
  }
  const status = outcome.response.status;
  const contentType = outcome.response.headers["content-type"] ?? "";
  if (status !== 200) {
    return {
      pass: false,
      verdict: "neutral",
      summary: `/openapi.json returned ${status}`,
    };
  }
  if (contentType.includes("text/html")) {
    return {
      pass: false,
      verdict: "neutral",
      summary: "/openapi.json returned HTML (likely soft-404)",
    };
  }
  const body = outcome.body ?? "";
  try {
    const parsed = JSON.parse(body);
    if (containsKeyDeep(parsed, "x-payment-info")) {
      return {
        pass: true,
        verdict: "positive",
        summary: "/openapi.json declares x-payment-info",
      };
    }
    return {
      pass: false,
      verdict: "neutral",
      summary: "/openapi.json has no x-payment-info extension",
    };
  } catch {
    return {
      pass: false,
      verdict: "neutral",
      summary: "/openapi.json response is not valid JSON",
    };
  }
}

export async function checkMpp(
  ctx: ScanContext,
): Promise<CheckResult> {
  const started = Date.now();
  const outcome = await ctx.fetch("/openapi.json");
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
