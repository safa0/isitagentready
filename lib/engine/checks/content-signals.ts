/**
 * Check: contentSignals (category: botAccessControl).
 *
 * Re-uses the scan context's memoised /robots.txt fetch and parses
 * Content-Signal directives following the contentsignals.org / IETF
 * draft-romm-aipref-contentsignals format:
 *
 *   User-Agent: *
 *   Content-Signal: search=yes, ai-input=yes, ai-train=no
 *
 * Each Content-Signal directive is scoped to the most recent User-agent group
 * (and optionally to a Path: line). Directive values are either yes or no;
 * recognised keys are search, ai-input, ai-train.
 *
 * Pass: at least one Content-Signal directive present.
 * Fail: 200 robots.txt with no Content-Signal directives.
 * Fail: non-200 robots.txt (cannot inspect).
 */

import {
  fetchToStep,
  makeStep,
  type FetchOutcome,
  type ScanContext,
} from "@/lib/engine/context";
import type { CheckResult, EvidenceStep } from "@/lib/schema";

const FETCH_LABEL = "GET /robots.txt";
const PARSE_LABEL = "Parse Content-Signal directives";
const CONCLUDE_LABEL = "Conclusion";

const PASS_MESSAGE = "Content Signals found in robots.txt";
const FAIL_NONE_MESSAGE = "No Content Signals found in robots.txt";
const FAIL_NO_ROBOTS_MESSAGE =
  "Cannot check Content Signals without robots.txt";

export interface ContentSignal {
  readonly userAgent: string;
  readonly path: string | null;
  readonly aiTrain: "yes" | "no" | null;
  readonly search: "yes" | "no" | null;
  readonly aiInput: "yes" | "no" | null;
}

function parseSignalValue(raw: string): "yes" | "no" | null {
  const v = raw.trim().toLowerCase();
  if (v === "yes") return "yes";
  if (v === "no") return "no";
  return null;
}

function parseContentSignals(body: string): ContentSignal[] {
  const signals: ContentSignal[] = [];
  let currentUa = "*";
  let currentPath: string | null = null;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.split("#")[0]!.trim();
    if (line.length === 0) continue;

    const uaMatch = /^user-agent\s*:\s*(.+)$/i.exec(line);
    if (uaMatch) {
      currentUa = uaMatch[1]!.trim();
      currentPath = null;
      continue;
    }

    const pathMatch = /^path\s*:\s*(.+)$/i.exec(line);
    if (pathMatch) {
      currentPath = pathMatch[1]!.trim();
      continue;
    }

    const signalMatch = /^content-signal\s*:\s*(.+)$/i.exec(line);
    if (signalMatch) {
      const directive: {
        userAgent: string;
        path: string | null;
        aiTrain: "yes" | "no" | null;
        search: "yes" | "no" | null;
        aiInput: "yes" | "no" | null;
      } = {
        userAgent: currentUa,
        path: currentPath,
        aiTrain: null,
        search: null,
        aiInput: null,
      };
      for (const part of signalMatch[1]!.split(",")) {
        const [rawKey, rawValue] = part.split("=");
        if (rawKey === undefined || rawValue === undefined) continue;
        const key = rawKey.trim().toLowerCase();
        const value = parseSignalValue(rawValue);
        if (value === null) continue;
        if (key === "ai-train") directive.aiTrain = value;
        else if (key === "search") directive.search = value;
        else if (key === "ai-input") directive.aiInput = value;
      }
      signals.push(directive);
    }
  }

  return signals;
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

export async function checkContentSignals(
  ctx: ScanContext,
): Promise<CheckResult> {
  const started = Date.now();
  const outcome = await ctx.getRobotsTxt();

  if (outcome.response === undefined || outcome.response.status !== 200) {
    return buildFailNoRobots(outcome, started);
  }

  const contentType = outcome.response.headers["content-type"] ?? "unknown";
  const body = outcome.body ?? "";
  const signals = parseContentSignals(body);

  const evidence: EvidenceStep[] = [];
  evidence.push(
    fetchToStep(outcome, FETCH_LABEL, {
      outcome: "positive",
      summary: `Received valid robots.txt (${outcome.response.status}, ${contentType})`,
    }),
  );

  if (signals.length > 0) {
    evidence.push(
      makeStep("parse", PARSE_LABEL, {
        outcome: "positive",
        summary: `Found ${signals.length} Content-Signal directive(s)`,
      }),
    );
    evidence.push(
      makeStep("conclude", CONCLUDE_LABEL, {
        outcome: "positive",
        summary: PASS_MESSAGE,
      }),
    );
    return {
      status: "pass",
      message: PASS_MESSAGE,
      details: { signals, signalCount: signals.length },
      evidence,
      durationMs: Date.now() - started,
    };
  }

  evidence.push(
    makeStep("parse", PARSE_LABEL, {
      outcome: "negative",
      summary: "No Content-Signal directives found in robots.txt",
    }),
  );
  evidence.push(
    makeStep("conclude", CONCLUDE_LABEL, {
      outcome: "negative",
      summary: FAIL_NONE_MESSAGE,
    }),
  );

  return {
    status: "fail",
    message: FAIL_NONE_MESSAGE,
    evidence,
    durationMs: Date.now() - started,
  };
}
