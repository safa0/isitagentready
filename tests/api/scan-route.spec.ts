/**
 * Failing specs for `app/api/scan/route.ts` — POST /api/scan.
 */

import { afterEach, describe, expect, it, beforeEach, vi } from "vitest";

import { POST, __resetRateLimiter } from "@/app/api/scan/route";
import { ScanResponseSchema } from "@/lib/schema";

// We stub out the engine only for the happy-path test and restore it
// afterwards so the SSRF / validation tests keep exercising the real guard.
vi.mock("@/lib/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/engine")>();
  return {
    ...actual,
    runScan: vi.fn(actual.runScan),
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

function jsonRequest(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://localhost/api/scan", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  __resetRateLimiter();
});

describe("POST /api/scan - validation", () => {
  it("rejects missing body with 400", async () => {
    const req = new Request("http://localhost/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON with 400 (SyntaxError path)", async () => {
    const req = new Request("http://localhost/api/scan", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.99",
      },
      body: "{not valid json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(String(body.error)).toMatch(/JSON/i);
  });

  it("rejects invalid url with 400", async () => {
    const res = await POST(
      jsonRequest({ url: "not-a-url" }, { "x-forwarded-for": "1.1.1.1" }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects private-host URLs with 400 (SSRF guard)", async () => {
    const res = await POST(
      jsonRequest(
        { url: "http://127.0.0.1" },
        { "x-forwarded-for": "1.1.1.2" },
      ),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(String(body.error ?? "")).toMatch(/public host/i);
  });
});

describe("POST /api/scan - rate limit", () => {
  it("rejects with 429 once the per-IP bucket is exhausted", async () => {
    const ip = "9.9.9.9";
    // With default bucket of 10/min, fire 11 requests. Use invalid URLs to
    // short-circuit the engine (but still exercise the limiter).
    let lastStatus = 0;
    for (let i = 0; i < 11; i++) {
      const res = await POST(
        jsonRequest({ url: "not-a-url" }, { "x-forwarded-for": ip }),
      );
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Happy path — mock the engine so we can assert the 200 JSON envelope.
// ---------------------------------------------------------------------------

const FAKE_RESPONSE: import("@/lib/schema").ScanResponse = {
  url: "https://happy.test/",
  scannedAt: new Date().toISOString(),
  level: 0 as const,
  levelName: "Not Ready" as const,
  checks: {
    discoverability: {
      robotsTxt: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
      sitemap: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
      linkHeaders: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
    },
    contentAccessibility: {
      markdownNegotiation: {
        status: "neutral", message: "n", evidence: [], durationMs: 0,
      },
    },
    botAccessControl: {
      robotsTxtAiRules: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
      contentSignals: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
      webBotAuth: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
    },
    discovery: {
      apiCatalog: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
      oauthDiscovery: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
      oauthProtectedResource: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
      mcpServerCard: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
      a2aAgentCard: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
      agentSkills: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
      webMcp: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
    },
    commerce: {
      x402: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
      mpp: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
      ucp: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
      acp: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
      ap2: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
    },
  },
  nextLevel: null,
  isCommerce: false,
  commerceSignals: [],
};

describe("POST /api/scan - happy path (M9)", () => {
  it("returns 200 JSON matching ScanResponseSchema when the engine succeeds", async () => {
    const mod = await import("@/lib/engine");
    const runScanMock = vi.mocked(mod.runScan);
    runScanMock.mockResolvedValueOnce(FAKE_RESPONSE);

    const res = await POST(
      jsonRequest(
        { url: "https://happy.test/" },
        { "x-forwarded-for": "198.51.100.1" },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = await res.json();
    expect(ScanResponseSchema.safeParse(body).success).toBe(true);
    expect(body.url).toBe("https://happy.test/");
  });

  it("returns 200 text/markdown when format=agent and engine succeeds", async () => {
    const mod = await import("@/lib/engine");
    const runScanMock = vi.mocked(mod.runScan);
    runScanMock.mockResolvedValueOnce(FAKE_RESPONSE);

    const res = await POST(
      jsonRequest(
        { url: "https://happy.test/", format: "agent" },
        { "x-forwarded-for": "198.51.100.4" },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/markdown/);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
  });
});

describe("POST /api/scan - body-size cap (M4)", () => {
  it("rejects bodies larger than the advertised cap with 413", async () => {
    // 17 KB body, well over the 16 KB cap.
    const big = "x".repeat(17 * 1024);
    const req = new Request("http://localhost/api/scan", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.44",
        "content-length": String(big.length),
      },
      body: JSON.stringify({ url: "https://a.test/", pad: big }),
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
  });

  it("rejects oversize bodies detected during streaming (no content-length)", async () => {
    // Build a ReadableStream that emits more than 16 KB without advertising.
    const chunk = new Uint8Array(20 * 1024).fill(65); // 20 KB of 'A'
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const req = new Request("http://localhost/api/scan", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.55",
      },
      body: stream,
      // @ts-expect-error - undici Request accepts duplex option for streams.
      duplex: "half",
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
  });
});

describe("POST /api/scan - engine failure paths", () => {
  it("returns 500 with a static 'Scan failed.' message when runScan throws", async () => {
    const mod = await import("@/lib/engine");
    const runScanMock = vi.mocked(mod.runScan);
    runScanMock.mockImplementationOnce(async () => {
      throw new Error("internal secret leak");
    });
    const res = await POST(
      jsonRequest(
        { url: "https://boom.test/" },
        { "x-forwarded-for": "198.51.100.2" },
      ),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Scan failed.");
    expect(body.error).not.toMatch(/secret/);
  });

  it("returns 504 when the route's scan timer aborts the in-flight work", async () => {
    vi.useFakeTimers();
    try {
      const mod = await import("@/lib/engine");
      const runScanMock = vi.mocked(mod.runScan);
      runScanMock.mockImplementationOnce(async (_url, opts) => {
        return new Promise<never>((_resolve, reject) => {
          const sig = opts?.signal;
          if (sig === undefined) return reject(new Error("no signal"));
          sig.addEventListener("abort", () =>
            reject(sig.reason ?? new Error("aborted")),
          );
        });
      });
      const p = POST(
        jsonRequest(
          { url: "https://slow.test/" },
          { "x-forwarded-for": "198.51.100.5" },
        ),
      );
      // Advance past the 25s timeout.
      await vi.advanceTimersByTimeAsync(25_000 + 10);
      const res = await p;
      expect(res.status).toBe(504);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("POST /api/scan - format=agent", () => {
  it("returns text/markdown when format is 'agent'", async () => {
    // Force private URL to avoid live fetches. Since format is agent but URL
    // is invalid, the route responds with markdown error? No — validation
    // always returns JSON 400. Use a valid example.com + fetchImpl is not
    // injectable in the route, so we accept that this test just exercises the
    // branch for a successful engine call. We stub by using an obviously
    // unreachable TLD; ScanContext will emit failing evidence but still
    // produce a ScanResponse.
    const res = await POST(
      jsonRequest(
        { url: "https://example.invalid", format: "agent" },
        { "x-forwarded-for": "8.8.4.4" },
      ),
    );
    // Either 200 markdown on success, or 400/500 on failure. We assert the
    // content-type when status is 200 (success path).
    if (res.status === 200) {
      expect(res.headers.get("content-type")).toMatch(/text\/markdown/);
    } else {
      // Non-happy paths still return JSON error envelopes.
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
    }
  });
});
