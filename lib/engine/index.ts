/**
 * Engine orchestrator — runScan(url, opts).
 *
 * Implemented in Phase 1 (engine core + first 6 checks) and Phase 2
 * (remaining 13 checks). Scoring + level synthesis plug in during Phase 3.
 */

import type { ScanRequest, ScanResponse } from "@/lib/schema";

export async function runScan(_req: ScanRequest): Promise<ScanResponse> {
  throw new Error("runScan: not implemented (Phase 1–3)");
}
