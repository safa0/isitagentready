/**
 * POST /api/scan — public scan API.
 *
 * Responsibilities:
 *   1. Zod-validate the request body against `ScanRequestSchema`.
 *   2. Run SSRF guard on the submitted URL.
 *   3. Rate-limit per client IP (simple in-memory token bucket).
 *   4. Apply a 60s timeout to the scan.
 *   5. Return JSON (default) or text/markdown (`format: "agent"`).
 *
 * This route is stateless from the client's perspective but holds a small
 * per-IP counter in process memory. That's fine for a single-instance Vercel
 * Fluid Compute deployment — if the app ever fans out, replace the in-memory
 * limiter with a Redis / Upstash backend.
 */

import { NextResponse } from "next/server";

import {
  ScanRequestSchema,
  type ScanResponse,
} from "@/lib/schema";
import { runScan } from "@/lib/engine";
import {
  normaliseScanUrl,
  assertPublicUrl,
  ScanUrlError,
} from "@/lib/engine/security";
import { getAgentReport } from "@/lib/engine/prompts";

// ---------------------------------------------------------------------------
// Rate limiter (per-IP token bucket)
// ---------------------------------------------------------------------------

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 10;
const SCAN_TIMEOUT_MS = 60_000;

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Token-bucket check. Returns `true` when the caller is allowed to proceed.
 * Implementation notes:
 *   - Buckets are per-IP; the key is derived from `x-forwarded-for`.
 *   - Buckets reset fully when the window elapses (simpler than token drip).
 *   - The map grows unbounded in worst case, but stale entries are lazily
 *     evicted on access.
 */
function checkRateLimit(key: string, now: number): boolean {
  const bucket = buckets.get(key);
  if (bucket === undefined || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (bucket.count >= RATE_LIMIT_MAX_REQUESTS) return false;
  bucket.count += 1;
  return true;
}

/** Test hook: clears the bucket map. Not exported from the module manifest. */
export function __resetRateLimiter(): void {
  buckets.clear();
}

function extractClientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for") ?? "";
  const first = forwarded.split(",")[0]?.trim();
  if (first !== undefined && first.length > 0) return first;
  const realIp = req.headers.get("x-real-ip");
  if (realIp !== null && realIp.length > 0) return realIp;
  return "unknown";
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

async function parseBody(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new SyntaxError("Request body is not valid JSON.");
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Scan timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function POST(req: Request): Promise<Response> {
  // 1. Rate limit.
  const ip = extractClientIp(req);
  const now = Date.now();
  if (!checkRateLimit(ip, now)) {
    return errorResponse("Too many requests. Please retry later.", 429);
  }

  // 2. Parse + validate body.
  let body: unknown;
  try {
    body = await parseBody(req);
  } catch (err) {
    const message = err instanceof SyntaxError ? err.message : "Invalid body.";
    return errorResponse(message, 400);
  }
  const parsed = ScanRequestSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const message =
      first !== undefined
        ? `Invalid request: ${first.path.join(".")} ${first.message}`
        : "Invalid request body.";
    return errorResponse(message, 400);
  }

  // 3. SSRF guard.
  let url: URL;
  try {
    url = normaliseScanUrl(parsed.data.url);
    assertPublicUrl(url);
  } catch (err) {
    const message = err instanceof ScanUrlError ? err.message : "Invalid URL.";
    return errorResponse(message, 400);
  }

  // 4. Run scan with timeout.
  let result: ScanResponse;
  try {
    result = await withTimeout(
      runScan(url.toString(), {
        profile: parsed.data.profile,
        enabledChecks: parsed.data.enabledChecks,
      }),
      SCAN_TIMEOUT_MS,
    );
  } catch (err) {
    // Deliberately opaque: do not leak internal state.
    if (err instanceof Error && /timed out/i.test(err.message)) {
      return errorResponse("Scan timed out.", 504);
    }
    return errorResponse("Scan failed.", 500);
  }

  // 5. Format response.
  if (parsed.data.format === "agent") {
    const body = getAgentReport({
      url: result.url,
      level: result.level,
      levelName: result.levelName,
      nextLevel: result.nextLevel,
      checks: result.checks as unknown as Record<
        string,
        Record<string, { status: string; message: string }>
      >,
      isCommerce: result.isCommerce,
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/markdown; charset=utf-8" },
    });
  }
  return NextResponse.json(result, { status: 200 });
}
