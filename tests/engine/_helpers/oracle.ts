/**
 * Test helpers shared across discovery-surface spec files.
 *
 * These helpers:
 * - Load the 5 oracle fixtures under `research/raw/*.json`.
 * - Build a deterministic `fetch` stub backed by a URL→response map.
 * - Compare a produced `CheckResult` against the oracle entry structurally
 *   (ignoring `durationMs` and tolerating extra request/response headers added
 *   by the shared scan context — e.g. the scanner's `user-agent`).
 *
 * IMPORTANT: this file is `.ts` (not `.spec.ts`) so vitest does not collect it
 * as a test file (see `vitest.config.ts` include pattern).
 */

import { expect, vi } from "vitest";
import type {
  CheckResult,
  EvidenceStep,
} from "@/lib/schema";

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
 */
export function expectCheckMatchesOracle(
  actual: CheckResult,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  oracle: any,
): void {
  expect(actual.status).toBe(oracle.status);
  expect(actual.message).toBe(oracle.message);
  expect(typeof actual.durationMs).toBe("number");

  if (oracle.details !== undefined) {
    expect(actual.details).toMatchObject(oracle.details);
  }

  expect(Array.isArray(actual.evidence)).toBe(true);
  expect(actual.evidence).toHaveLength(oracle.evidence.length);

  oracle.evidence.forEach(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (expectedStep: any, i: number) => {
      assertStepMatches(actual.evidence[i]!, expectedStep, i);
    },
  );
}

function assertStepMatches(
  actual: EvidenceStep,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expected: any,
  index: number,
): void {
  expect(
    actual.action,
    `evidence[${index}].action`,
  ).toBe(expected.action);
  expect(
    actual.label,
    `evidence[${index}].label`,
  ).toBe(expected.label);
  expect(
    actual.finding,
    `evidence[${index}].finding`,
  ).toEqual(expected.finding);

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
    expect(actual.response!.statusText).toBe(expected.response.statusText);
    if (expected.response.headers !== undefined) {
      expect(actual.response!.headers).toMatchObject(expected.response.headers);
    }
  } else {
    expect(actual.response, `evidence[${index}].response`).toBeUndefined();
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
// Re-exports for brevity in specs
// ---------------------------------------------------------------------------

export { vi };
