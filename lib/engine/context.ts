/**
 * Shared scan context: one-per-scan fetch wrapper that captures
 * `{ request, response, finding }` triples for the evidence timeline, plus
 * homepage and robots.txt probes that checks can share without refetching.
 *
 * Design notes
 * ------------
 * - Immutable: `createScanContext` returns a frozen object; internal caches are
 *   lazy promise-memoized so concurrent callers share a single in-flight fetch.
 * - Dependency-injected fetch (`options.fetchImpl`) keeps checks unit-testable
 *   without network calls.
 * - Body previews match the real Cloudflare scanner: first 500 chars of the
 *   body with a `...` suffix when truncated (verified against
 *   `research/raw/*.json` fixtures — all preview strings are ≤ 503 chars).
 * - Transport errors (DNS, TLS, timeout, aborts) are returned as a
 *   `FetchOutcome` with `error` set and `response` undefined, so individual
 *   checks can map failures to `fail` / `neutral` evidence steps.
 */

import type {
  EvidenceAction,
  EvidenceStep,
  FindingOutcome,
} from "@/lib/schema";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * User-Agent used for all outbound probes. Advertises purpose + project URL so
 * origin operators can identify and whitelist the scanner. Callers may
 * override via `ScanContextOptions.userAgent`.
 */
export const DEFAULT_USER_AGENT =
  "AgentReadinessScanner/1.0 (+https://github.com/safa0/isitagentready)";

/** Per-request timeout budget (ms). */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Max characters of response body retained in `response.bodyPreview`. */
export const BODY_PREVIEW_MAX_CHARS = 500;

/** Suffix appended to a truncated preview. */
export const BODY_PREVIEW_TRUNCATED_SUFFIX = "...";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ScanContextOptions {
  /** Origin to scan. Only the origin is preserved; path/search/hash discarded. */
  readonly url: URL | string;
  readonly userAgent?: string;
  readonly timeoutMs?: number;
  /** Inject a fetch implementation (for tests). Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Monotonic clock source for durationMs measurement. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface FetchRequestRecord {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

export interface FetchResponseRecord {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Record<string, string>;
  readonly bodyPreview?: string;
}

export interface FetchOutcome {
  readonly request: FetchRequestRecord;
  readonly response?: FetchResponseRecord;
  /** Full response body (not truncated). Present on success only. */
  readonly body?: string;
  /** Transport-level error message (when `response` is undefined). */
  readonly error?: string;
  readonly durationMs: number;
}

export interface FetchOptions {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly timeoutMs?: number;
}

export interface ScanContext {
  readonly origin: string;
  readonly url: URL;
  readonly userAgent: string;
  readonly timeoutMs: number;
  /** Resolve an absolute URL or site-relative path against the scan origin. */
  resolve(pathOrUrl: string): URL;
  /** Perform a single fetch and return a standardised outcome record. */
  fetch(pathOrUrl: string, opts?: FetchOptions): Promise<FetchOutcome>;
  /** Memoised `GET /` — used by linkHeaders, webMcp, commerce-signals. */
  getHomepage(): Promise<FetchOutcome>;
  /** Memoised `GET /robots.txt` — used by robotsTxt, robotsTxtAiRules, contentSignals, sitemap. */
  getRobotsTxt(): Promise<FetchOutcome>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a body preview capped at `BODY_PREVIEW_MAX_CHARS`. When the body
 * exceeds the cap, a `...` suffix is appended. Returns `undefined` for an
 * empty body so the field can be omitted cleanly from the evidence step.
 */
export function toBodyPreview(body: string): string | undefined {
  if (body.length === 0) return undefined;
  if (body.length <= BODY_PREVIEW_MAX_CHARS) return body;
  return body.slice(0, BODY_PREVIEW_MAX_CHARS) + BODY_PREVIEW_TRUNCATED_SUFFIX;
}

/**
 * Materialise a `Headers` object into a plain record with lowercase keys —
 * matches what the reference scanner emits in its evidence payload.
 */
export function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * Convert a raw `FetchOutcome` to an `EvidenceStep` with a `fetch` action.
 * Most checks compose two or three steps: one `fetch`, zero or more `parse`
 * / `validate` steps (via `makeStep`), and a terminal `conclude` step.
 */
export function fetchToStep(
  outcome: FetchOutcome,
  label: string,
  finding: { readonly outcome: FindingOutcome; readonly summary: string },
): EvidenceStep {
  const step: EvidenceStep = {
    action: "fetch",
    label,
    request: outcome.request,
    finding,
  };
  if (outcome.response !== undefined) {
    return { ...step, response: outcome.response };
  }
  return step;
}

/** Build a non-network evidence step (parse / validate / conclude). */
export function makeStep(
  action: EvidenceAction,
  label: string,
  finding: { readonly outcome: FindingOutcome; readonly summary: string },
): EvidenceStep {
  return { action, label, finding };
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function normaliseOrigin(input: URL | string): URL {
  const raw = typeof input === "string" ? new URL(input) : input;
  if (raw.protocol !== "http:" && raw.protocol !== "https:") {
    throw new Error(
      `createScanContext: unsupported protocol "${raw.protocol}" (expected http: or https:)`,
    );
  }
  // Only preserve origin; checks always target well-known paths on the origin.
  return new URL(raw.origin);
}

async function performFetch(
  input: URL,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  now: () => number,
  requestRecord: FetchRequestRecord,
): Promise<FetchOutcome> {
  const started = now();
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetchImpl(input, { ...init, signal });
    let body = "";
    let readError: string | undefined;
    try {
      body = await res.text();
    } catch (err) {
      readError = err instanceof Error ? err.message : String(err);
    }
    const response: FetchResponseRecord = {
      status: res.status,
      statusText: res.statusText,
      headers: headersToRecord(res.headers),
      ...(readError === undefined && body.length > 0
        ? { bodyPreview: toBodyPreview(body) }
        : {}),
    };
    const outcome: FetchOutcome = {
      request: requestRecord,
      response,
      durationMs: now() - started,
      ...(readError === undefined ? { body } : { error: readError }),
    };
    return outcome;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      request: requestRecord,
      error,
      durationMs: now() - started,
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createScanContext(options: ScanContextOptions): ScanContext {
  const url = normaliseOrigin(options.url);
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;

  if (typeof fetchImpl !== "function") {
    throw new Error(
      "createScanContext: no fetch implementation available (pass options.fetchImpl or run on Node ≥ 18)",
    );
  }

  let homepagePromise: Promise<FetchOutcome> | null = null;
  let robotsPromise: Promise<FetchOutcome> | null = null;

  function resolve(pathOrUrl: string): URL {
    return new URL(pathOrUrl, url);
  }

  async function doFetch(
    pathOrUrl: string,
    opts: FetchOptions = {},
  ): Promise<FetchOutcome> {
    const target = resolve(pathOrUrl);
    const method = (opts.method ?? "GET").toUpperCase();
    const mergedHeaders: Record<string, string> = {
      "user-agent": userAgent,
      ...(opts.headers ?? {}),
    };
    const requestRecord: FetchRequestRecord = {
      url: target.toString(),
      method,
      headers: mergedHeaders,
    };
    const init: RequestInit = {
      method,
      headers: mergedHeaders,
      redirect: "follow",
      ...(opts.body !== undefined ? { body: opts.body } : {}),
    };
    return performFetch(
      target,
      init,
      opts.timeoutMs ?? timeoutMs,
      fetchImpl,
      now,
      requestRecord,
    );
  }

  function getHomepage(): Promise<FetchOutcome> {
    if (homepagePromise === null) {
      homepagePromise = doFetch("/");
    }
    return homepagePromise;
  }

  function getRobotsTxt(): Promise<FetchOutcome> {
    if (robotsPromise === null) {
      robotsPromise = doFetch("/robots.txt");
    }
    return robotsPromise;
  }

  return Object.freeze({
    origin: url.origin,
    url,
    userAgent,
    timeoutMs,
    resolve,
    fetch: doFetch,
    getHomepage,
    getRobotsTxt,
  });
}
