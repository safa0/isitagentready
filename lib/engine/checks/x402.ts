/**
 * Commerce check: `x402`.
 *
 * Reference: FINDINGS §3 + §9. Spec: https://www.x402.org/.
 *
 * Fetch plan (matches the reference scanner's evidence shape):
 *   1. `GET /`                                        — home probe, looking for 402
 *   2. `GET /platform/v2/x402/discovery/resources`    — x402 bazaar (coinbase)
 *   3. `GET /api`                                     — common API root
 *   4. `GET /api/v1`                                  — common versioned API root
 *
 * Pass criteria: ANY of the origin probes (1, 3, 4) returns status 402 with
 * an x402 payment requirements body, OR the origin appears in the bazaar
 * response data[].
 *
 * Commerce gating: when `isCommerce === false`, the final `status` is
 * forced to "neutral" and " (not a commerce site)" is appended to the
 * message. Evidence and detail payloads are preserved verbatim so the
 * audit view still shows what was probed.
 */

import {
  fetchToStep,
  makeStep,
  type ScanContext,
  type FetchOutcome,
} from "@/lib/engine/context";
import type { CheckResult, EvidenceStep } from "@/lib/schema";
import { applyCommerceGate } from "@/lib/engine/commerce-signals";

export const X402_BAZAAR_URL =
  "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=500";

const CONCLUDE_LABEL = "Conclusion";
const FAIL_MESSAGE = "x402 payment protocol not detected";
const PASS_MESSAGE = "x402 payment protocol detected";

interface Options {
  readonly isCommerce: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Verify that a 402 response body looks like x402 payment requirements.
 * A stray 402 (e.g. a Stripe-style error envelope) must not count. The
 * x402 protocol mandates either `x402Version` at the root or an
 * `accepts[]` array of payment requirements.
 *
 * We require EITHER a typed `x402Version` (string or number) OR a
 * non-empty `accepts[]`. A bare `{accepts: []}` is rejected — an empty
 * requirements list is not meaningful and overlaps with generic 402
 * envelopes we've seen in the wild.
 */
function isX402Body(body: string | undefined): boolean {
  if (body === undefined || body.length === 0) return false;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== "object") return false;
    const obj = parsed as Record<string, unknown>;
    const version = obj["x402Version"];
    const hasVersion =
      typeof version === "string" || typeof version === "number";
    const accepts = obj["accepts"];
    const acceptsNonEmpty = Array.isArray(accepts) && accepts.length > 0;
    return hasVersion || acceptsNonEmpty;
  } catch {
    return false;
  }
}

function probeFinding(
  label: string,
  outcome: FetchOutcome,
): { outcome: "positive" | "neutral" | "negative"; summary: string } {
  if (outcome.response === undefined) {
    return {
      outcome: "neutral",
      summary: `${label} request failed: ${outcome.error ?? "no response"}`,
    };
  }
  const status = outcome.response.status;
  if (status === 402) {
    if (isX402Body(outcome.body)) {
      return {
        outcome: "positive",
        summary: `${label} returned 402 (x402 payment required)`,
      };
    }
    return {
      outcome: "neutral",
      summary: `${label} returned 402 but body is not an x402 payment requirements document`,
    };
  }
  return {
    outcome: "neutral",
    summary: `${label} returned ${status} (not 402)`,
  };
}

interface BazaarEntry {
  readonly origin?: unknown;
  readonly host?: unknown;
  readonly url?: unknown;
  readonly resource?: unknown;
}

/**
 * Normalise a host-ish string for comparison:
 * - lowercase
 * - strip a single trailing "." (root-zone FQDN form, e.g. `a.com.`)
 * - strip a `:<port>` suffix (host vs hostname parity; bazaar entries may
 *   include explicit non-default ports)
 */
function normaliseHost(h: string): string {
  let out = h.toLowerCase();
  if (out.endsWith(".")) out = out.slice(0, -1);
  const colon = out.lastIndexOf(":");
  if (colon !== -1) {
    const port = out.slice(colon + 1);
    if (port.length > 0 && /^\d+$/.test(port)) {
      out = out.slice(0, colon);
    }
  }
  return out;
}

/**
 * Compare a bazaar candidate string to the expected host using exact hostname
 * equality (case-insensitive). We previously used substring matching, which is
 * vulnerable to host-confusion: a scan of `a.com` would match a bazaar entry
 * for `a.com.evil.test`. Parsing as a URL and comparing `hostname` exactly
 * closes that attack surface. If the candidate is a bare host (no scheme),
 * we compare the normalised bare hosts directly so a candidate like
 * `a.com:8443` still matches `a.com` / `a.com:8443`.
 *
 * `URL` construction for a well-formed `https://<host>` input effectively
 * never throws, so we deliberately do not wrap it in try/catch — a bare-host
 * fallback covers the no-scheme case explicitly.
 */
function hostMatches(candidate: string, expected: string): boolean {
  const exp = normaliseHost(expected);
  if (candidate.includes("://")) {
    const u = new URL(candidate);
    // `u.hostname` strips the port; normalise trailing-dot only.
    return normaliseHost(u.hostname) === exp;
  }
  return normaliseHost(candidate) === exp;
}

function bazaarMatchesHost(body: string, host: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    const container =
      parsed !== null && typeof parsed === "object"
        ? (parsed as { data?: unknown; resources?: unknown })
        : {};
    const entries: BazaarEntry[] = Array.isArray(container.data)
      ? (container.data as BazaarEntry[])
      : Array.isArray(container.resources)
        ? (container.resources as BazaarEntry[])
        : Array.isArray(parsed)
          ? (parsed as BazaarEntry[])
          : [];
    for (const entry of entries) {
      const candidates = [entry.origin, entry.host, entry.url, entry.resource];
      for (const c of candidates) {
        if (typeof c === "string" && hostMatches(c, host)) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

function bazaarCount(body: string): number {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object") {
      const container = parsed as { data?: unknown; resources?: unknown };
      if (Array.isArray(container.data)) return container.data.length;
      if (Array.isArray(container.resources)) return container.resources.length;
    }
    if (Array.isArray(parsed)) return parsed.length;
    return 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function checkX402(
  ctx: ScanContext,
  opts: Options,
): Promise<CheckResult> {
  const started = Date.now();

  // Fetch all four probes in parallel.
  const [homeOutcome, bazaarOutcome, apiOutcome, apiV1Outcome] =
    await Promise.all([
      ctx.getHomepage(),
      ctx.fetch(X402_BAZAAR_URL),
      ctx.fetch("/api"),
      ctx.fetch("/api/v1"),
    ]);

  const evidence: EvidenceStep[] = [];
  let pass = false;

  // 1) Homepage
  const homeFinding = probeFinding("/", homeOutcome);
  if (homeFinding.outcome === "positive") pass = true;
  evidence.push(fetchToStep(homeOutcome, "GET /", homeFinding));

  // 2) Bazaar — compare against `hostname` (port-stripped). Using `host`
  // (which includes an explicit port) would cause an origin like
  // `example.com:8443` to miss bazaar entries recorded without a port.
  const host = ctx.url.hostname;
  let bazaarSummary: string;
  let bazaarOutcomeVerdict: "positive" | "neutral" | "negative" = "neutral";
  if (bazaarOutcome.response === undefined) {
    bazaarSummary = `Bazaar API request failed: ${bazaarOutcome.error ?? "no response"}`;
  } else if (bazaarOutcome.response.status !== 200) {
    bazaarSummary = `Bazaar API returned ${bazaarOutcome.response.status}`;
  } else {
    const body = bazaarOutcome.body ?? "";
    const count = bazaarCount(body);
    if (bazaarMatchesHost(body, host)) {
      pass = true;
      bazaarOutcomeVerdict = "positive";
      bazaarSummary = `Bazaar API returned ${count} entries, matched ${host}`;
    } else {
      bazaarSummary = `Bazaar API returned ${count} entries, none matching ${host}`;
    }
  }
  evidence.push(
    fetchToStep(bazaarOutcome, "GET /platform/v2/x402/discovery/resources", {
      outcome: bazaarOutcomeVerdict,
      summary: bazaarSummary,
    }),
  );

  // 3) /api
  const apiFinding = probeFinding("/api", apiOutcome);
  if (apiFinding.outcome === "positive") pass = true;
  evidence.push(fetchToStep(apiOutcome, "GET /api", apiFinding));

  // 4) /api/v1
  const apiV1Finding = probeFinding("/api/v1", apiV1Outcome);
  if (apiV1Finding.outcome === "positive") pass = true;
  evidence.push(fetchToStep(apiV1Outcome, "GET /api/v1", apiV1Finding));

  if (pass) {
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
      opts.isCommerce,
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
    opts.isCommerce,
  );
}
