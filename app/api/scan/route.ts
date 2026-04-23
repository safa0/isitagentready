/**
 * POST /api/scan — public scan API.
 *
 * Responsibilities:
 *   1. Zod-validate the request body against `ScanRequestSchema`.
 *   2. Rate-limit per client IP via the shared rate limiter.
 *   3. Apply a scan-wide timeout (cancels in-flight fetches via AbortSignal).
 *   4. Return JSON (default) or text/markdown (`format: "agent"`).
 *
 * SSRF validation lives inside `runScan` — we catch `ScanUrlError` here to
 * return a 400 without re-running the guard in the route (defence in depth
 * still holds: the engine re-validates every redirect hop).
 *
 * Rate limiting is shared with the MCP route via `lib/api/rate-limiter.ts`;
 * the same in-process bucket governs both endpoints so a caller cannot
 * double their budget by rotating transports.
 */

import { NextResponse } from "next/server";

import {
  ScanRequestSchema,
  type ScanResponse,
} from "@/lib/schema";
import { runScan, ScanUrlError } from "@/lib/engine";
import { getAgentReport } from "@/lib/engine/prompts";
import {
  defaultRateLimiter,
  extractClientIp,
  rateLimitHeaders,
} from "@/lib/api/rate-limiter";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Vercel Fluid Compute hard cap is 30s; we leave a small reserve. */
const SCAN_TIMEOUT_MS = 25_000;
/** Reject bodies larger than this before parsing. */
const MAX_BODY_BYTES = 16 * 1024;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorResponse(
  message: string,
  status: number,
  extraHeaders: Record<string, string> = {},
): NextResponse {
  return NextResponse.json(
    { error: message },
    { status, headers: extraHeaders },
  );
}

async function readBodyCapped(
  req: Request,
  maxBytes: number,
): Promise<string> {
  // Fast pre-check using Content-Length when advertised.
  const advertised = req.headers.get("content-length");
  if (advertised !== null) {
    const n = Number.parseInt(advertised, 10);
    if (Number.isFinite(n) && n > maxBytes) {
      throw new PayloadTooLargeError(
        `Request body exceeds ${maxBytes} bytes.`,
      );
    }
  }
  const body = req.body;
  if (body === null) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let received = 0;
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new PayloadTooLargeError(
          `Request body exceeds ${maxBytes} bytes.`,
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // releaseLock throws if already closed.
    }
  }
}

class PayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}

async function parseBody(req: Request): Promise<unknown> {
  const text = await readBodyCapped(req, MAX_BODY_BYTES);
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new SyntaxError("Request body is not valid JSON.");
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(req: Request): Promise<Response> {
  // 1. Rate limit.
  const ip = extractClientIp(req);
  const now = Date.now();
  if (!defaultRateLimiter.check(ip, now)) {
    return errorResponse(
      "Too many requests. Please retry later.",
      429,
      rateLimitHeaders(defaultRateLimiter.snapshot(ip, now)),
    );
  }
  const limitHeaders = rateLimitHeaders(defaultRateLimiter.snapshot(ip, now));

  // 2. Parse + validate body.
  let body: unknown;
  try {
    body = await parseBody(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      return errorResponse(err.message, 413, limitHeaders);
    }
    const message = err instanceof SyntaxError ? err.message : "Invalid body.";
    return errorResponse(message, 400, limitHeaders);
  }
  const parsed = ScanRequestSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const message =
      first !== undefined
        ? `Invalid request: ${first.path.join(".")} ${first.message}`
        : "Invalid request body.";
    return errorResponse(message, 400, limitHeaders);
  }

  // 3. Run scan with scan-wide timeout. The AbortController propagates into
  // every fetch via the context's composed signal, so a timeout really
  // cancels outstanding work instead of letting it orphan.
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Scan timed out after ${SCAN_TIMEOUT_MS}ms.`));
  }, SCAN_TIMEOUT_MS);

  let result: ScanResponse;
  try {
    result = await runScan(parsed.data.url, {
      profile: parsed.data.profile,
      enabledChecks: parsed.data.enabledChecks,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof ScanUrlError) {
      return errorResponse(err.message, 400, limitHeaders);
    }
    if (controller.signal.aborted) {
      return errorResponse("Scan timed out.", 504, limitHeaders);
    }
    // Deliberately opaque: do not leak internal state.
    return errorResponse("Scan failed.", 500, limitHeaders);
  } finally {
    clearTimeout(timer);
  }

  // 4. Format response.
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
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        ...limitHeaders,
      },
    });
  }
  return NextResponse.json(result, { status: 200, headers: limitHeaders });
}
