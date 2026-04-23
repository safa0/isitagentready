/**
 * Specs for the shared rate limiter and client-IP extraction.
 *
 * Covers:
 *   - token-bucket accounting and window reset
 *   - MAX_BUCKETS sweep (H3: unbounded map fix)
 *   - IP extraction prefers platform-trusted headers (H2: XFF spoof bypass)
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRateLimiter,
  defaultRateLimiter,
  extractClientIp,
  mcpRateLimiter,
  MCP_MAX_REQUESTS,
  DEFAULT_MAX_REQUESTS,
  rateLimitHeaders,
} from "@/lib/api/rate-limiter";

describe("createRateLimiter - token bucket", () => {
  it("allows up to maxRequests within the window and rejects the next", () => {
    const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 3 });
    const now = 1_000_000;
    expect(limiter.check("ip", now)).toBe(true);
    expect(limiter.check("ip", now)).toBe(true);
    expect(limiter.check("ip", now)).toBe(true);
    expect(limiter.check("ip", now)).toBe(false);
  });

  it("resets the bucket once the window elapses", () => {
    const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 1 });
    const now = 1_000_000;
    expect(limiter.check("ip", now)).toBe(true);
    expect(limiter.check("ip", now + 500)).toBe(false);
    expect(limiter.check("ip", now + 1500)).toBe(true);
  });
});

describe("createRateLimiter - bounded map", () => {
  it("sweeps expired buckets when the hard cap is reached", () => {
    const limiter = createRateLimiter({
      windowMs: 100,
      maxRequests: 1,
      maxBuckets: 5,
    });
    // Seed 5 buckets at t=0.
    for (let i = 0; i < 5; i++) {
      expect(limiter.check(`ip-${i}`, 0)).toBe(true);
    }
    expect(limiter.size()).toBe(5);

    // Add a 6th at t=200 — all prior buckets are expired, sweep evicts
    // them and we land back at 1 live entry.
    expect(limiter.check("ip-new", 200)).toBe(true);
    expect(limiter.size()).toBe(1);
  });

  it("honours an explicit maxBuckets under load", () => {
    const limiter = createRateLimiter({
      windowMs: 10_000,
      maxRequests: 1,
      maxBuckets: 3,
    });
    // Fill above cap. Nothing is expired so we drop oldest-resetAt.
    for (let i = 0; i < 10; i++) {
      limiter.check(`ip-${i}`, i);
    }
    expect(limiter.size()).toBeLessThanOrEqual(3);
  });
});

describe("defaultRateLimiter.reset", () => {
  it("empties the shared map", () => {
    defaultRateLimiter.check("ip", Date.now());
    expect(defaultRateLimiter.size()).toBeGreaterThan(0);
    defaultRateLimiter.reset();
    expect(defaultRateLimiter.size()).toBe(0);
  });
});

describe("rateLimiter - snapshot", () => {
  it("returns full-budget snapshot for an untracked key", () => {
    const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 5 });
    const snap = limiter.snapshot("fresh", 1_000_000);
    expect(snap.limit).toBe(5);
    expect(snap.remaining).toBe(5);
    expect(snap.resetAt).toBe(1_001_000);
  });

  it("decrements remaining after each check() call", () => {
    const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 3 });
    limiter.check("ip", 1);
    expect(limiter.snapshot("ip", 1).remaining).toBe(2);
    limiter.check("ip", 1);
    expect(limiter.snapshot("ip", 1).remaining).toBe(1);
  });

  it("clamps remaining to 0 once the cap is hit", () => {
    const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 1 });
    limiter.check("ip", 1);
    limiter.check("ip", 1); // denied
    expect(limiter.snapshot("ip", 1).remaining).toBe(0);
  });
});

describe("mcpRateLimiter", () => {
  it("has a lower cap than the default (REST) limiter", () => {
    expect(MCP_MAX_REQUESTS).toBeLessThan(DEFAULT_MAX_REQUESTS);
  });

  it("exposes its tighter cap via snapshot()", () => {
    mcpRateLimiter.reset();
    const snap = mcpRateLimiter.snapshot("who", Date.now());
    expect(snap.limit).toBe(MCP_MAX_REQUESTS);
  });
});

describe("rateLimitHeaders", () => {
  it("renders X-RateLimit-* fields from a snapshot", () => {
    const headers = rateLimitHeaders({
      limit: 10,
      remaining: 4,
      resetAt: 1_700_000_500,
    });
    expect(headers["x-ratelimit-limit"]).toBe("10");
    expect(headers["x-ratelimit-remaining"]).toBe("4");
    // Reset is epoch-SECONDS (ceil of epoch-millis / 1000).
    expect(headers["x-ratelimit-reset"]).toBe("1700001");
  });
});

describe("extractClientIp", () => {
  function reqWith(headers: Record<string, string>): Request {
    return new Request("http://localhost/", { method: "POST", headers });
  }

  it("prefers x-vercel-forwarded-for over x-forwarded-for", () => {
    const req = reqWith({
      "x-vercel-forwarded-for": "203.0.113.1",
      "x-forwarded-for": "1.1.1.1",
    });
    expect(extractClientIp(req)).toBe("203.0.113.1");
  });

  it("uses the RIGHTMOST x-forwarded-for entry (platform annotation)", () => {
    const req = reqWith({
      "x-forwarded-for": "evil-client, platform-hop, 203.0.113.2",
    });
    expect(extractClientIp(req)).toBe("203.0.113.2");
  });

  it("falls back to x-real-ip when XFF is absent", () => {
    const req = reqWith({ "x-real-ip": "198.51.100.7" });
    expect(extractClientIp(req)).toBe("198.51.100.7");
  });

  it("returns 'unknown' when no trustworthy header is present", () => {
    const req = reqWith({});
    expect(extractClientIp(req)).toBe("unknown");
  });

  it("ignores an empty x-forwarded-for header", () => {
    const req = reqWith({ "x-forwarded-for": "   " });
    expect(extractClientIp(req)).toBe("unknown");
  });

  it("does not accept a spoofed leftmost XFF value", () => {
    // The important property: `extractClientIp` must NOT return
    // "attacker-spoofed" when a real platform hop is present.
    const req = reqWith({
      "x-forwarded-for": "attacker-spoofed, 203.0.113.9",
    });
    expect(extractClientIp(req)).not.toBe("attacker-spoofed");
    expect(extractClientIp(req)).toBe("203.0.113.9");
  });
});

describe("extractClientIp - untrusted forwarding posture (MED-5)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function reqWith(headers: Record<string, string>): Request {
    return new Request("http://localhost/", { method: "POST", headers });
  }

  it("ignores x-forwarded-for when neither VERCEL=1 nor TRUST_FORWARDED=true", () => {
    // vitest.config sets TRUST_FORWARDED=true for the whole test run; we
    // un-trust it for this case to exercise the default off-platform posture.
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUST_FORWARDED", "");
    const req = reqWith({ "x-forwarded-for": "203.0.113.99" });
    expect(extractClientIp(req)).toBe("unknown");
  });

  it("ignores x-real-ip when neither VERCEL=1 nor TRUST_FORWARDED=true", () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUST_FORWARDED", "");
    const req = reqWith({ "x-real-ip": "198.51.100.2" });
    expect(extractClientIp(req)).toBe("unknown");
  });

  it("still honours x-vercel-forwarded-for regardless of env (platform always injects)", () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUST_FORWARDED", "");
    const req = reqWith({ "x-vercel-forwarded-for": "203.0.113.33" });
    expect(extractClientIp(req)).toBe("203.0.113.33");
  });

  it("honours XFF when TRUST_FORWARDED=true (operator opt-in)", () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUST_FORWARDED", "true");
    const req = reqWith({ "x-forwarded-for": "203.0.113.44" });
    expect(extractClientIp(req)).toBe("203.0.113.44");
  });

  it("honours XFF when VERCEL=1", () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("TRUST_FORWARDED", "");
    const req = reqWith({ "x-forwarded-for": "203.0.113.55" });
    expect(extractClientIp(req)).toBe("203.0.113.55");
  });
});
