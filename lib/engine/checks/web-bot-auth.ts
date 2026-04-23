/**
 * Bot access control check: `webBotAuth` (informational).
 *
 * Specification
 * -------------
 * - Probe: `GET /.well-known/http-message-signatures-directory` (IETF Web Bot
 *   Auth WG — an HTTP Message Signatures key directory served as a JWKS).
 * - Pass criterion: 200 response + JSON body with a non-empty `keys` array
 *   (RFC 7517).
 * - Never fails hard: absence / malformed directory resolves to `status:
 *   "neutral"` and is excluded from scoring (FINDINGS §5 — neutrals are
 *   informational).
 *
 * Evidence timeline
 * -----------------
 * - 404 / transport error: `fetch → conclude` (2 steps).
 * - 200 but invalid JWKS: `fetch → validate → conclude` (3 steps).
 * - 200 valid JWKS: `fetch → validate → conclude` (3 steps, all positive).
 */

import type { CheckResult, EvidenceStep } from "@/lib/schema";
import {
  fetchToStep,
  makeStep,
  type ScanContext,
} from "@/lib/engine/context";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROBE_PATH = "/.well-known/http-message-signatures-directory";
const FETCH_LABEL = "GET /.well-known/http-message-signatures-directory";
const VALIDATE_LABEL = "Validate JWKS structure";
const CONCLUDE_LABEL = "Conclusion";

const MESSAGE_NOT_FOUND =
  "Web Bot Auth directory not found (informational only)";
const MESSAGE_MISSING_KEYS =
  "Web Bot Auth directory is missing required 'keys' array (informational only)";
const MESSAGE_INVALID_JSON =
  "Web Bot Auth directory did not return valid JSON (informational only)";
const MESSAGE_VALID =
  "Web Bot Auth directory present with valid JWKS";

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

function hasNonEmptyKeysArray(json: unknown): boolean {
  if (json === null || typeof json !== "object") return false;
  const keys = (json as { keys?: unknown }).keys;
  return Array.isArray(keys) && keys.length > 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function checkWebBotAuth(ctx: ScanContext): Promise<CheckResult> {
  const started = Date.now();
  const outcome = await ctx.fetch(PROBE_PATH);

  const evidence: EvidenceStep[] = [];

  // Transport error → neutral.
  if (outcome.response === undefined) {
    const err = outcome.error ?? "Request failed";
    evidence.push(
      fetchToStep(outcome, FETCH_LABEL, {
        outcome: "negative",
        summary: `Transport error fetching Web Bot Auth directory: ${err}`,
      }),
    );
    evidence.push(
      makeStep("conclude", CONCLUDE_LABEL, {
        outcome: "negative",
        summary: "Web Bot Auth directory not found",
      }),
    );
    return {
      status: "neutral",
      message: MESSAGE_NOT_FOUND,
      evidence,
      durationMs: Date.now() - started,
    };
  }

  const { response } = outcome;

  // Non-200 → neutral (not found).
  if (response.status !== 200) {
    evidence.push(
      fetchToStep(outcome, FETCH_LABEL, {
        outcome: "negative",
        summary: `Server returned ${response.status} -- Web Bot Auth directory not found`,
      }),
    );
    evidence.push(
      makeStep("conclude", CONCLUDE_LABEL, {
        outcome: "negative",
        summary: "Web Bot Auth directory not found",
      }),
    );
    return {
      status: "neutral",
      message: MESSAGE_NOT_FOUND,
      evidence,
      durationMs: Date.now() - started,
    };
  }

  // 200 → record the fetch step (neutral-ish finding), then validate body.
  evidence.push(
    fetchToStep(outcome, FETCH_LABEL, {
      outcome: "positive",
      summary: "Received Web Bot Auth directory (200)",
    }),
  );

  const json = tryParseJson(outcome.body);
  if (json === undefined) {
    evidence.push(
      makeStep("validate", VALIDATE_LABEL, {
        outcome: "negative",
        summary: "Response body is not valid JSON",
      }),
    );
    evidence.push(
      makeStep("conclude", CONCLUDE_LABEL, {
        outcome: "negative",
        summary: "Web Bot Auth directory did not return valid JSON",
      }),
    );
    return {
      status: "neutral",
      message: MESSAGE_INVALID_JSON,
      evidence,
      durationMs: Date.now() - started,
    };
  }

  if (!hasNonEmptyKeysArray(json)) {
    evidence.push(
      makeStep("validate", VALIDATE_LABEL, {
        outcome: "negative",
        summary: "Missing required 'keys' array per RFC 7517",
      }),
    );
    evidence.push(
      makeStep("conclude", CONCLUDE_LABEL, {
        outcome: "negative",
        summary: "Web Bot Auth directory is missing required 'keys' array",
      }),
    );
    return {
      status: "neutral",
      message: MESSAGE_MISSING_KEYS,
      evidence,
      durationMs: Date.now() - started,
    };
  }

  // Valid JWKS with non-empty keys[] → pass.
  const keyCount = (json as { keys: unknown[] }).keys.length;
  evidence.push(
    makeStep("validate", VALIDATE_LABEL, {
      outcome: "positive",
      summary: `Valid JWKS with ${keyCount} key(s)`,
    }),
  );
  evidence.push(
    makeStep("conclude", CONCLUDE_LABEL, {
      outcome: "positive",
      summary: MESSAGE_VALID,
    }),
  );

  return {
    status: "pass",
    message: MESSAGE_VALID,
    details: { keyCount },
    evidence,
    durationMs: Date.now() - started,
  };
}
