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
 * Three steps: homepage fetch, well-known fetch, conclusion. The two fetches
 * run concurrently; emission order follows resolution order (oracle fixtures
 * show both orderings).
 */

import type { CheckResult, EvidenceStep } from "@/lib/schema";
import {
  fetchToStep,
  makeStep,
  type FetchOutcome,
  type ScanContext,
  type FetchRequestRecord,
} from "@/lib/engine/context";

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

function tryParseJson(body: string | undefined): unknown | undefined {
  if (body === undefined || body.length === 0) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly metadata?: Record<string, any>;
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

  type Tagged =
    | { kind: "homepage"; outcome: FetchOutcome; finding: HomepageFinding }
    | { kind: "well-known"; outcome: FetchOutcome; finding: WellKnownFinding };

  const homepageP: Promise<Tagged> = ctx.getHomepage().then((outcome) => ({
    kind: "homepage" as const,
    outcome,
    finding: analyseHomepage(outcome),
  }));
  const wellKnownP: Promise<Tagged> = ctx.fetch(WELL_KNOWN_PATH).then(
    (outcome) => ({
      kind: "well-known" as const,
      outcome,
      finding: analyseWellKnown(outcome),
    }),
  );

  const collected: Tagged[] = [];
  await Promise.all(
    [homepageP, wellKnownP].map(async (p) => {
      collected.push(await p);
    }),
  );

  const evidence: EvidenceStep[] = [];
  let wellKnown: Extract<Tagged, { kind: "well-known" }> | undefined;

  for (const item of collected) {
    if (item.kind === "homepage") {
      // The homepage probe request URL should match the oracle: origin without
      // trailing slash. Rebuild the request record accordingly.
      const rewritten: FetchOutcome = {
        ...item.outcome,
        request: rewriteHomepageRequest(item.outcome.request, ctx.origin),
      };
      evidence.push(
        fetchToStep(rewritten, HOMEPAGE_FETCH_LABEL, {
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

/**
 * Oracle records the homepage fetch URL as the origin without trailing slash
 * (e.g. `https://example.com`, not `https://example.com/`). The scan context
 * always resolves `/` to `origin/`, so we rewrite the request record to
 * match the expected shape on this specific check.
 */
function rewriteHomepageRequest(
  request: FetchRequestRecord,
  origin: string,
): FetchRequestRecord {
  if (request.url === `${origin}/`) {
    return { ...request, url: origin };
  }
  return request;
}
