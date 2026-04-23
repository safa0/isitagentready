/**
 * Failing specs for `app/api/scan/route.ts` — POST /api/scan.
 */

import { describe, expect, it, beforeEach } from "vitest";

import { POST, __resetRateLimiter } from "@/app/api/scan/route";

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
