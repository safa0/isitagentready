/**
 * Commerce check: `acp` (Agentic Commerce Protocol).
 *
 * Reference: FINDINGS §3 + §9. Spec: https://agenticcommerce.dev/.
 *
 * Fetch plan: `GET /.well-known/acp.json`.
 * Pass criteria:
 *   - response is 200, AND
 *   - body parses as JSON, AND
 *   - `protocol.name === "acp"`, AND
 *   - `api_base_url` is present (truthy string), AND
 *   - `transports[]` is a non-empty array, AND
 *   - `capabilities.services[]` is a non-empty array.
 */

import {
  fetchToStep,
  makeStep,
  type ScanContext,
  type FetchOutcome,
} from "@/lib/engine/context";
import type { CheckResult, EvidenceStep } from "@/lib/schema";
import { applyCommerceGate } from "@/lib/engine/commerce-signals";

const FETCH_LABEL = "GET /.well-known/acp.json";
const CONCLUDE_LABEL = "Conclusion";

const PASS_MESSAGE = "ACP discovery document found";
const FAIL_MESSAGE = "ACP discovery document not found";

function isNonEmptyArray(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0;
}

function evaluate(outcome: FetchOutcome): {
  pass: boolean;
  summary: string;
  verdict: "positive" | "negative";
} {
  if (outcome.response === undefined) {
    return {
      pass: false,
      verdict: "negative",
      summary: `ACP request failed: ${outcome.error ?? "no response"}`,
    };
  }
  const status = outcome.response.status;
  if (status !== 200) {
    return {
      pass: false,
      verdict: "negative",
      summary: `Server returned ${status} -- ACP discovery document not found`,
    };
  }
  const body = outcome.body ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      pass: false,
      verdict: "negative",
      summary: "ACP discovery response is not valid JSON",
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      pass: false,
      verdict: "negative",
      summary: "ACP discovery body is not a JSON object",
    };
  }
  const obj = parsed as Record<string, unknown>;
  const protocol = obj["protocol"];
  const protocolName =
    protocol !== null && typeof protocol === "object"
      ? (protocol as Record<string, unknown>)["name"]
      : undefined;
  if (protocolName !== "acp") {
    return {
      pass: false,
      verdict: "negative",
      summary: `ACP protocol.name is not "acp"`,
    };
  }
  const apiBase = obj["api_base_url"];
  if (typeof apiBase !== "string" || apiBase.length === 0) {
    return {
      pass: false,
      verdict: "negative",
      summary: "ACP discovery missing api_base_url",
    };
  }
  if (!isNonEmptyArray(obj["transports"])) {
    return {
      pass: false,
      verdict: "negative",
      summary: "ACP discovery has no transports",
    };
  }
  const capabilities = obj["capabilities"];
  const services =
    capabilities !== null && typeof capabilities === "object"
      ? (capabilities as Record<string, unknown>)["services"]
      : undefined;
  if (!isNonEmptyArray(services)) {
    return {
      pass: false,
      verdict: "negative",
      summary: "ACP discovery has no capabilities.services",
    };
  }
  return {
    pass: true,
    verdict: "positive",
    summary: "ACP discovery document is valid",
  };
}

export async function checkAcp(
  ctx: ScanContext,
): Promise<CheckResult> {
  const started = Date.now();
  const outcome = await ctx.fetch("/.well-known/acp.json");
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
