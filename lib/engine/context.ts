/**
 * Shared scan context: one-per-scan fetch wrapper that captures
 * `{ request, response, finding }` triples for the evidence timeline, plus a
 * homepage probe and robots.txt cache that checks can share without refetching.
 *
 * Populated in Phase 1 (see PLAN.md).
 */

export interface ScanContextOptions {
  readonly url: URL;
  readonly userAgent?: string;
  readonly timeoutMs?: number;
}

export interface ScanContext {
  readonly origin: string;
  readonly url: URL;
  // implemented in Phase 1
}

export function createScanContext(_options: ScanContextOptions): ScanContext {
  throw new Error("createScanContext: not implemented (Phase 1)");
}
