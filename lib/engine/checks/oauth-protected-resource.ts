/**
 * Discovery check: `oauthProtectedResource` (RFC 9728).
 *
 * Specification (FINDINGS §3 / §9)
 * --------------------------------
 * - Probe homepage (`GET /`) to look for a `WWW-Authenticate` header
 *   advertising an OAuth resource server.
 * - Probe `/.well-known/oauth-protected-resource` for the canonical metadata.
 * - Pass criterion: well-known returns 200 JSON with a `resource` field.
 *
 * Evidence timeline
 * -----------------
 * Both probes run concurrently but we emit their evidence in a fixed dispatch
 * order (homepage first, well-known second) regardless of resolution timing —
 * that keeps the output deterministic for any caller that iterates evidence.
 *
 * Step budget:
 *   - Pass path:  3 steps  (homepage fetch, well-known fetch, conclude)
 *   - Fail path:  3 steps  (homepage fetch, well-known fetch, conclude)
 */

import type { CheckResult, EvidenceStep } from "@/lib/schema";
import {
  fetchToStep,
  makeStep,
  type FetchOutcome,
  type ScanContext,
} from "@/lib/engine/context";
import { tryParseJson } from "./_shared";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WELL_KNOWN_PATH = "/.well-known/oauth-protected-resource";
const HOMEPAGE_FETCH_LABEL = "GET /";
const WELL_KNOWN_FETCH_LABEL = "GET /.well-known/oauth-protected-resource";
const CONCLUDE_LABEL = "Conclusion";

const PASS_MESSAGE = "OAuth Protected Resource Metadata found";
const FAIL_MESSAGE = "No OAuth Protected Resource Metadata found";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface HomepageFinding {
  readonly summary: string;
  readonly outcome: "positive" | "neutral" | "negative";
  readonly wwwAuthenticate?: string;
}

function analyseHomepage(outcome: FetchOutcome): HomepageFinding {
  if (outcome.response === undefined) {
    return {
      outcome: "negative",
      summary: `Homepage request failed: ${outcome.error ?? "no response"}`,
    };
  }
  const www = outcome.response.headers["www-authenticate"];
  if (www !== undefined && www.length > 0) {
    return {
      outcome: "positive",
      summary: `Homepage advertises WWW-Authenticate: ${www}`,
      wwwAuthenticate: www,
    };
  }
  return {
    outcome: "neutral",
    summary: `Homepage returned ${outcome.response.status} (no WWW-Authenticate header)`,
  };
}

interface WellKnownFinding {
  readonly summary: string;
  readonly outcome: "positive" | "negative";
  readonly resource?: string;
  readonly metadata?: Record<string, unknown>;
}

function analyseWellKnown(outcome: FetchOutcome): WellKnownFinding {
  if (outcome.response === undefined) {
    return {
      outcome: "negative",
      summary: `Request failed: ${outcome.error ?? "no response"}`,
    };
  }
  if (outcome.response.status !== 200) {
    return {
      outcome: "negative",
      summary: `Returned ${outcome.response.status}`,
    };
  }
  const json = tryParseJson(outcome.body);
  if (json === null || typeof json !== "object") {
    return {
      outcome: "negative",
      summary: "Returned 200 but body was not valid JSON",
    };
  }
  const resource = (json as { resource?: unknown }).resource;
  if (typeof resource !== "string" || resource.length === 0) {
    return {
      outcome: "negative",
      summary: "Returned 200 JSON but missing required 'resource' field",
    };
  }
  return {
    outcome: "positive",
    summary: `Received valid Protected Resource metadata (resource: ${resource})`,
    resource,
    metadata: json as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function checkOauthProtectedResource(
  ctx: ScanContext,
): Promise<CheckResult> {
  const started = Date.now();

  interface HomepageProbe {
    readonly kind: "homepage";
    readonly outcome: FetchOutcome;
    readonly finding: HomepageFinding;
  }
  interface WellKnownProbe {
    readonly kind: "well-known";
    readonly outcome: FetchOutcome;
    readonly finding: WellKnownFinding;
  }
  type Probe = HomepageProbe | WellKnownProbe;

  const homepageP: Promise<Probe> = ctx.getHomepage().then((outcome) => ({
    kind: "homepage" as const,
    outcome,
    finding: analyseHomepage(outcome),
  }));
  const wellKnownP: Promise<Probe> = ctx.fetch(WELL_KNOWN_PATH).then(
    (outcome) => ({
      kind: "well-known" as const,
      outcome,
      finding: analyseWellKnown(outcome),
    }),
  );

  // Collect index-aligned so evidence emission follows dispatch order, not
  // resolution order. Immutable (no `.push` onto a freshly allocated array).
  const results: readonly Probe[] = await Promise.all([homepageP, wellKnownP]);

  const evidence: EvidenceStep[] = [];
  let wellKnown: WellKnownProbe | undefined;

  for (const item of results) {
    if (item.kind === "homepage") {
      evidence.push(
        fetchToStep(item.outcome, HOMEPAGE_FETCH_LABEL, {
          outcome: item.finding.outcome,
          summary: item.finding.summary,
        }),
      );
    } else {
      wellKnown = item;
      evidence.push(
        fetchToStep(item.outcome, WELL_KNOWN_FETCH_LABEL, {
          outcome: item.finding.outcome,
          summary: item.finding.summary,
        }),
      );
    }
  }

  if (wellKnown?.finding.outcome === "positive" && wellKnown.finding.resource) {
    evidence.push(
      makeStep("conclude", CONCLUDE_LABEL, {
        outcome: "positive",
        summary: PASS_MESSAGE,
      }),
    );
    return {
      status: "pass",
      message: PASS_MESSAGE,
      details: { resource: wellKnown.finding.resource },
      evidence,
      durationMs: Date.now() - started,
    };
  }

  evidence.push(
    makeStep("conclude", CONCLUDE_LABEL, {
      outcome: "negative",
      summary: FAIL_MESSAGE,
    }),
  );
  return {
    status: "fail",
    message: FAIL_MESSAGE,
    evidence,
    durationMs: Date.now() - started,
  };
}
