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
    return {
      outcome: "positive",
      summary: `${label} returned 402 (x402 payment required)`,
    };
  }
  return {
    outcome: "neutral",
    summary: `${label} returned ${status} (not 402)`,
  };
}

function originHost(ctx: ScanContext): string {
  return ctx.url.host;
}

interface BazaarEntry {
  readonly origin?: unknown;
  readonly host?: unknown;
  readonly url?: unknown;
  readonly resource?: unknown;
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
    const lcHost = host.toLowerCase();
    for (const entry of entries) {
      const candidates = [entry.origin, entry.host, entry.url, entry.resource];
      for (const c of candidates) {
        if (typeof c === "string" && c.toLowerCase().includes(lcHost)) {
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

  // 2) Bazaar
  const host = originHost(ctx);
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
