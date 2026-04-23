/**
 * Discovery check: `apiCatalog` (RFC 9727).
 *
 * Specification (FINDINGS §3 / §9)
 * --------------------------------
 * - Probe `GET /.well-known/api-catalog` with
 *   `Accept: application/linkset+json, application/json`.
 * - Pass criterion: 200 response + `application/linkset+json` content type
 *   + non-empty `linkset[]` array in the body.
 *
 * Divergence from the full RFC 9727 flow
 * --------------------------------------
 * RFC 9727 also allows advertising the catalog via a homepage `Link` header
 * (`rel="api-catalog"`) or a `/llms.txt` reference. The current oracle
 * fixtures only exercise the well-known probe, so this check intentionally
 * implements only that path. Expanding to Link-header / llms.txt probing is
 * deferred until we have real pass fixtures to ground-truth against.
 *
 * Evidence timeline
 * -----------------
 * Fail path (all 5 oracle fixtures): `fetch → conclude`.
 * Pass path: `fetch → validate → conclude`.
 */

import type { CheckResult, EvidenceStep } from "@/lib/schema";
import {
  fetchToStep,
  makeStep,
  type ScanContext,
} from "@/lib/engine/context";
import { tryParseJson } from "./_shared";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROBE_PATH = "/.well-known/api-catalog";
const FETCH_LABEL = "GET /.well-known/api-catalog";
const VALIDATE_LABEL = "Validate linkset structure";
const CONCLUDE_LABEL = "Conclusion";

const ACCEPT_HEADER = "application/linkset+json, application/json";

const PASS_MESSAGE = "API Catalog found";
const FAIL_MESSAGE = "API Catalog not found";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isLinksetJson(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  return contentType.toLowerCase().includes("application/linkset+json");
}

function extractLinkset(json: unknown): unknown[] | undefined {
  if (json === null || typeof json !== "object") return undefined;
  const linkset = (json as { linkset?: unknown }).linkset;
  if (!Array.isArray(linkset)) return undefined;
  return linkset;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function checkApiCatalog(ctx: ScanContext): Promise<CheckResult> {
  const started = Date.now();
  const outcome = await ctx.fetch(PROBE_PATH, {
    headers: { Accept: ACCEPT_HEADER },
  });

  const evidence: EvidenceStep[] = [];

  // Transport error.
  if (outcome.response === undefined) {
    evidence.push(
      fetchToStep(outcome, FETCH_LABEL, {
        outcome: "negative",
        summary: `Transport error fetching API Catalog: ${outcome.error ?? "no response"}`,
      }),
    );
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

  const { response } = outcome;

  // Non-200.
  if (response.status !== 200) {
    evidence.push(
      fetchToStep(outcome, FETCH_LABEL, {
        outcome: "negative",
        summary: `Server returned ${response.status} -- API Catalog not found`,
      }),
    );
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

  // 200 — check content-type + linkset body.
  const contentType = response.headers["content-type"];
  const json = tryParseJson(outcome.body);
  const linkset = extractLinkset(json);

  if (
    !isLinksetJson(contentType) ||
    linkset === undefined ||
    linkset.length === 0
  ) {
    const reason =
      linkset === undefined
        ? "Response body is not a linkset JSON document"
        : linkset.length === 0
          ? "Linkset is empty"
          : `Unexpected content-type ${contentType ?? "(none)"} -- expected application/linkset+json`;
    evidence.push(
      fetchToStep(outcome, FETCH_LABEL, {
        outcome: "negative",
        summary: `Received 200 but ${reason.toLowerCase()}`,
      }),
    );
    evidence.push(
      makeStep("validate", VALIDATE_LABEL, {
        outcome: "negative",
        summary: reason,
      }),
    );
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

  // Pass.
  evidence.push(
    fetchToStep(outcome, FETCH_LABEL, {
      outcome: "positive",
      summary: "Received 200 with linkset+json body",
    }),
  );
  evidence.push(
    makeStep("validate", VALIDATE_LABEL, {
      outcome: "positive",
      summary: `Linkset contains ${linkset.length} entry(ies)`,
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
    details: { linksetSize: linkset.length },
    evidence,
    durationMs: Date.now() - started,
  };
}
