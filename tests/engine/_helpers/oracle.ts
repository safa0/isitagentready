/**
 * Test helpers shared across discovery-surface spec files.
 *
 * These helpers:
 * - Load the 5 oracle fixtures under `research/raw/*.json`.
 * - Build a deterministic `fetch` stub backed by a URL→response map.
 * - Compare a produced `CheckResult` against the oracle entry structurally
 *   (ignoring `durationMs` and tolerating extra request/response headers added
 *   by the shared scan context — e.g. the scanner's `user-agent`).
 * - Provide a single `runCheckAgainstOracle` runner that the 5 Phase-2 specs
 *   reuse so route synthesis and context wiring live in one place.
 *
 * IMPORTANT: this file is `.ts` (not `.spec.ts`) so vitest does not collect it
 * as a test file (see `vitest.config.ts` include pattern).
 */

import { expect, vi } from "vitest";
import type {
  CheckResult,
  EvidenceStep,
} from "@/lib/schema";
import { createScanContext, type ScanContext } from "@/lib/engine/context";

import cfDev from "../../../research/raw/scan-cf-dev.json";
import example from "../../../research/raw/scan-example.json";
import vercel from "../../../research/raw/scan-vercel.json";
import cf from "../../../research/raw/scan-cf.json";
import shopify from "../../../research/raw/scan-shopify.json";

// ---------------------------------------------------------------------------
// Fixture registry
// ---------------------------------------------------------------------------

export type OracleSite =
  | "cf-dev"
  | "example"
  | "vercel"
  | "cf"
  | "shopify";

export interface OracleFixture {
  readonly site: OracleSite;
  readonly origin: string;
  readonly url: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly raw: any;
}

// Cast to loose shape — we only read known fields defensively.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FIXTURES: Record<OracleSite, any> = {
  "cf-dev": cfDev,
  example,
  vercel,
  cf,
  shopify,
};

export function loadOracle(site: OracleSite): OracleFixture {
  const raw = FIXTURES[site];
  const url = raw.url as string;
  const origin = new URL(url).origin;
  return { site, origin, url, raw };
}

export const ALL_SITES: readonly OracleSite[] = [
  "cf-dev",
  "example",
  "vercel",
  "cf",
  "shopify",
] as const;

// ---------------------------------------------------------------------------
// Fetch stubs
// ---------------------------------------------------------------------------

export interface StubResponseInit {
  readonly status: number;
  readonly statusText?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

export type StubHandler = StubResponseInit | Error;

export interface FetchStub {
  readonly fetchImpl: typeof fetch;
  readonly calls: string[];
}

/**
 * Build a deterministic fetch stub keyed by absolute URL.
 *
 * - Unknown URLs throw (so each spec explicitly declares its routes).
 * - Error handlers simulate transport failures (DNS, timeout, TLS).
 * - Response bodies are served verbatim; the scanner wrapper is responsible
 *   for body truncation, so specs that care about bodyPreview must provide a
 *   body that reproduces the oracle preview after truncation.
 */
export function makeFetchStub(
  routes: Record<string, StubHandler>,
): FetchStub {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push(url);
    const handler = routes[url];
    if (handler === undefined) {
      throw new Error(`fetch stub: unexpected URL ${url}`);
    }
    if (handler instanceof Error) throw handler;
    return new Response(handler.body ?? "", {
      status: handler.status,
      statusText: handler.statusText ?? defaultStatusText(handler.status),
      headers: handler.headers ?? {},
    });
  };
  return { fetchImpl, calls };
}

function defaultStatusText(status: number): string {
  if (status === 200) return "OK";
  if (status === 404) return "Not Found";
  if (status === 500) return "Internal Server Error";
  if (status === 503) return "Service Unavailable";
  return "OK";
}

// ---------------------------------------------------------------------------
// Oracle comparison
// ---------------------------------------------------------------------------

/** Strip a single trailing slash for URL comparison. */
function normaliseUrl(u: string): string {
  return u.endsWith("/") ? u.slice(0, -1) : u;
}

/**
 * Compare a CheckResult to the oracle entry structurally.
 *
 * - status + message must match exactly.
 * - `details` must match when the oracle provides it (other keys ignored).
 * - evidence length must match.
 * - Each evidence step must match action/label/finding; request.url is
 *   compared modulo trailing slash; response.status/statusText must match
 *   exactly; response.headers are compared with `objectContaining` so the
 *   oracle's subset is required but extras from the real wire format are OK.
 * - `durationMs` is never compared (varies per run).
 * - `bodyPreview` is not compared (derived from body; spec authors can assert
 *   on it separately when needed).
 *
 * Note on evidence ordering: the 5 oracle fixtures were captured live and
 * their step order reflects resolution order at capture time. The engine now
 * emits evidence in fixed DISPATCH order (deterministic). Specs therefore
 * validate the label SET matches the oracle — sequence equality is validated
 * only when the oracle sequence happens to match our dispatch order.
 */
export interface OracleStepLike {
  readonly action: string;
  readonly label: string;
  readonly finding?: {
    readonly outcome: string;
    readonly summary?: string;
  };
  readonly request?: { readonly url: string; readonly method: string };
  readonly response?: {
    readonly status: number;
    readonly statusText?: string;
    readonly headers?: Record<string, string>;
    readonly bodyPreview?: string;
  };
}

export interface OracleCheckLike {
  readonly status: CheckResult["status"];
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly evidence: readonly OracleStepLike[];
}

export interface ExpectOracleOpts {
  /**
   * How to compare evidence ordering:
   *   - "strict" (default): evidence[i] must match oracle.evidence[i] in order.
   *   - "by-label": match each actual step to the oracle step with the same
   *     label (in order of first occurrence). Use when the oracle's capture
   *     order reflects live resolution order but our implementation emits in
   *     a fixed dispatch order that happens to differ for some fixtures.
   */
  readonly evidenceOrder?: "strict" | "by-label";
}

export function expectCheckMatchesOracle(
  actual: CheckResult,
  oracle: OracleCheckLike,
  opts: ExpectOracleOpts = {},
): void {
  expect(actual.status).toBe(oracle.status);
  expect(actual.message).toBe(oracle.message);
  expect(typeof actual.durationMs).toBe("number");

  if (oracle.details !== undefined) {
    expect(actual.details).toMatchObject(oracle.details);
  }

  expect(Array.isArray(actual.evidence)).toBe(true);
  expect(actual.evidence).toHaveLength(oracle.evidence.length);

  const order = opts.evidenceOrder ?? "strict";
  if (order === "strict") {
    oracle.evidence.forEach((expectedStep, i) => {
      assertStepMatches(actual.evidence[i]!, expectedStep, i);
    });
    return;
  }

  // by-label: pair each actual step with an oracle step of the same label,
  // then run the same assertions. Both lists are consumed in a stable 1:1
  // fashion so duplicate labels still round-trip correctly.
  const remainingOracle: OracleStepLike[] = [...oracle.evidence];
  actual.evidence.forEach((actualStep, i) => {
    const matchIdx = remainingOracle.findIndex(
      (e) => e.label === actualStep.label && e.action === actualStep.action,
    );
    if (matchIdx === -1) {
      throw new Error(
        `evidence[${i}] (action=${actualStep.action}, label=${actualStep.label}) ` +
          `has no matching oracle step`,
      );
    }
    const [expected] = remainingOracle.splice(matchIdx, 1);
    assertStepMatches(actualStep, expected!, i);
  });
}

function assertStepMatches(
  actual: EvidenceStep,
  expected: OracleStepLike,
  index: number,
): void {
  expect(actual.action, `evidence[${index}].action`).toBe(expected.action);
  expect(actual.label, `evidence[${index}].label`).toBe(expected.label);
  if (expected.finding !== undefined) {
    expect(
      actual.finding.outcome,
      `evidence[${index}].finding.outcome`,
    ).toBe(expected.finding.outcome);
    if (expected.finding.summary !== undefined) {
      expect(
        actual.finding.summary,
        `evidence[${index}].finding.summary`,
      ).toBe(expected.finding.summary);
    }
  }

  if (expected.request !== undefined) {
    expect(actual.request, `evidence[${index}].request`).toBeDefined();
    expect(actual.request!.method).toBe(expected.request.method);
    expect(normaliseUrl(actual.request!.url)).toBe(
      normaliseUrl(expected.request.url),
    );
  }

  if (expected.response !== undefined) {
    expect(actual.response, `evidence[${index}].response`).toBeDefined();
    expect(actual.response!.status).toBe(expected.response.status);
    if (expected.response.statusText !== undefined) {
      expect(actual.response!.statusText).toBe(expected.response.statusText);
    }
    if (expected.response.headers !== undefined) {
      expect(actual.response!.headers).toMatchObject(expected.response.headers);
    }
  }
}

// ---------------------------------------------------------------------------
// Body reconstruction
// ---------------------------------------------------------------------------

/**
 * Reproduce a response body that — once run through the scan context's
 * truncation logic — yields the oracle's recorded `bodyPreview`.
 *
 * - If the oracle preview ends with "..." it was truncated; we pad with a
 *   repeat of the preview's own content so the post-truncation preview is
 *   byte-identical.
 * - Otherwise the preview IS the body.
 */
export function bodyFromPreview(preview: string | undefined): string {
  if (preview === undefined) return "";
  if (preview.endsWith("...") && preview.length > 500) {
    const head = preview.slice(0, 500);
    // Duplicate head to guarantee >500 chars of body → wrapper truncates to
    // exactly `head + "..."`, matching the oracle preview.
    return head + head;
  }
  return preview;
}

// ---------------------------------------------------------------------------
// Shared oracle runner
// ---------------------------------------------------------------------------

export interface RunCheckAgainstOracleOpts<R> {
  readonly site: OracleSite;
  /** Pluck the oracle entry for the check under test from the raw fixture. */
  readonly getOracleEntry: (raw: unknown) => OracleCheckLike;
  /** Run the check against a stubbed scan context. */
  readonly runCheck: (ctx: ScanContext) => Promise<R>;
  /**
   * When the oracle's response has no `bodyPreview` but the check needs a body
   * to succeed (e.g. Cloudflare truncates 200 JSON responses), return a synth
   * body here. Called once per fetch evidence step.
   */
  readonly synthesiseBody?: (
    step: OracleStepLike,
    oracle: OracleCheckLike,
  ) => string | undefined;
  /**
   * Register extra routes not present in the oracle evidence (e.g. alias the
   * homepage URL shape). Receives the origin and the in-progress route map.
   */
  readonly extraRoutes?: (
    origin: string,
    routes: Record<string, StubHandler>,
  ) => void;
}

export interface RunCheckAgainstOracleResult<R> {
  readonly result: R;
  readonly oracle: OracleCheckLike;
  readonly origin: string;
  readonly calls: string[];
}

/**
 * Standard oracle round-trip harness for Phase-2 checks. Builds a fetch stub
 * from the oracle's recorded request/response pairs and runs the check
 * against a real `ScanContext`. Centralising this in one place means:
 *
 *   - route synthesis logic (e.g. body reconstruction from preview) lives in
 *     a single location and is easy to audit;
 *   - per-spec boilerplate stays tight — each spec supplies only a check
 *     accessor + the actual check function;
 *   - behavioural tweaks (e.g. adding request header assertions) propagate
 *     to all 5 specs at once.
 */
export async function runCheckAgainstOracle<R>(
  opts: RunCheckAgainstOracleOpts<R>,
): Promise<RunCheckAgainstOracleResult<R>> {
  const fixture = loadOracle(opts.site);
  const oracle = opts.getOracleEntry(fixture.raw);

  const routes: Record<string, StubHandler> = {};
  for (const step of oracle.evidence) {
    if (step.action !== "fetch" || !step.request || !step.response) continue;
    const previewBody = bodyFromPreview(step.response.bodyPreview);
    const synthesised = opts.synthesiseBody?.(step, oracle);
    const body = previewBody.length > 0 ? previewBody : (synthesised ?? "");
    const handler: StubResponseInit = {
      status: step.response.status,
      statusText: step.response.statusText,
      headers: step.response.headers ?? {},
      body,
    };
    routes[step.request.url] = handler;
    // The oracle records the homepage URL as `${origin}` (no trailing slash)
    // but the scan context always issues `${origin}/`. Register both forms so
    // the stub serves whichever shape the check under test produces.
    if (step.request.url === fixture.origin) {
      routes[`${fixture.origin}/`] = handler;
    } else if (step.request.url === `${fixture.origin}/`) {
      routes[fixture.origin] = handler;
    }
  }

  // Defensive: surface the bug immediately if a spec's extraRoutes callback
  // accidentally shadows a route already populated from the oracle evidence.
  // We snapshot the pre-call handler references, run the callback, and throw
  // if any oracle-owned key was deleted or reassigned.
  if (opts.extraRoutes !== undefined) {
    const snapshot = new Map<string, StubHandler>(Object.entries(routes));
    opts.extraRoutes(fixture.origin, routes);
    for (const [key, handler] of snapshot) {
      if (!(key in routes)) {
        throw new Error(
          `runCheckAgainstOracle: extraRoutes deleted oracle route ${key}`,
        );
      }
      if (routes[key] !== handler) {
        throw new Error(
          `runCheckAgainstOracle: extraRoutes shadowed oracle route ${key}`,
        );
      }
    }
  }

  const stub = makeFetchStub(routes);
  const ctx = createScanContext({
    url: fixture.url,
    fetchImpl: stub.fetchImpl,
  });
  const result = await opts.runCheck(ctx);
  return {
    result,
    oracle,
    origin: fixture.origin,
    calls: stub.calls,
  };
}

// ---------------------------------------------------------------------------
// Re-exports for brevity in specs
// ---------------------------------------------------------------------------

export { vi };
