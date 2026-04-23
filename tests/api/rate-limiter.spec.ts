/**
 * Specs for the shared rate limiter and client-IP extraction.
 *
 * Covers:
 *   - token-bucket accounting and window reset
 *   - MAX_BUCKETS sweep (H3: unbounded map fix)
 *   - IP extraction prefers platform-trusted headers (H2: XFF spoof bypass)
 */

import { describe, expect, it } from "vitest";

import {
  createRateLimiter,
  defaultRateLimiter,
  extractClientIp,
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
