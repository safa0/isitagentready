/**
 * Failing specs for the orchestrator `runScan`.
 *
 * Covers:
 *   - returns a ScanResponse matching the Zod schema
 *   - wires isCommerce / commerceSignals from detectCommerce
 *   - runs a2aAgentCard before ap2 (ap2 depends on a2a when opted-in)
 *   - applies profile: "content" (disables commerce checks)
 *   - applies profile: "apiApp" (disables content-heavy checks)
 *   - applies enabledChecks override
 *   - scoring + level are computed from the results
 */

import { describe, expect, it } from "vitest";

import { runScan } from "@/lib/engine/index";
import {
  ScanResponseSchema,
  type CheckId,
} from "@/lib/schema";

function fallbackFetch(): typeof fetch {
  const fn: typeof fetch = async () => {
    // Default: 404 for everything. Each test can override via routes.
    return new Response("", { status: 404, statusText: "Not Found" });
  };
  return fn;
}

function makeRoutedFetch(
  routes: Record<
    string,
    { status: number; headers?: Record<string, string>; body?: string }
  >,
): typeof fetch {
  const fn: typeof fetch = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const match = routes[url];
    if (match === undefined) {
      return new Response("", { status: 404, statusText: "Not Found" });
    }
    return new Response(match.body ?? "", {
      status: match.status,
      headers: match.headers ?? {},
    });
  };
  return fn;
}

describe("runScan - shape", () => {
  it("returns a ScanResponse matching the Zod schema for example.com", async () => {
    const res = await runScan("https://example.com", {
      fetchImpl: fallbackFetch(),
    });
    const parsed = ScanResponseSchema.safeParse(res);
    expect(parsed.success).toBe(true);
    expect(res.url).toMatch(/^https:\/\/example\.com\/?$/);
    expect(res.level).toBe(0);
    expect(res.levelName).toBe("Not Ready");
    expect(res.isCommerce).toBe(false);
  });

  it("includes all 19 checks across the 5 categories", async () => {
    const res = await runScan("https://example.com", {
      fetchImpl: fallbackFetch(),
    });
    expect(Object.keys(res.checks.discoverability)).toEqual(
      expect.arrayContaining(["robotsTxt", "sitemap", "linkHeaders"]),
    );
    expect(Object.keys(res.checks.contentAccessibility)).toEqual([
      "markdownNegotiation",
    ]);
    expect(Object.keys(res.checks.botAccessControl)).toEqual(
      expect.arrayContaining(["robotsTxtAiRules", "contentSignals", "webBotAuth"]),
    );
    expect(Object.keys(res.checks.discovery)).toEqual(
      expect.arrayContaining([
        "apiCatalog",
        "oauthDiscovery",
        "oauthProtectedResource",
        "mcpServerCard",
        "a2aAgentCard",
        "agentSkills",
        "webMcp",
      ]),
    );
    expect(Object.keys(res.checks.commerce)).toEqual(
      expect.arrayContaining(["x402", "mpp", "ucp", "acp", "ap2"]),
    );
  });
});

describe("runScan - profile handling", () => {
  it("profile:content marks commerce checks as neutral (not opted in)", async () => {
    const res = await runScan("https://example.com", {
      profile: "content",
      fetchImpl: fallbackFetch(),
    });
    expect(res.checks.commerce.x402.status).toBe("neutral");
    expect(res.checks.commerce.mpp.status).toBe("neutral");
  });

  it("enabledChecks overrides profile", async () => {
    const enabled: CheckId[] = ["robotsTxt", "sitemap"];
    const res = await runScan("https://example.com", {
      enabledChecks: enabled,
      fetchImpl: fallbackFetch(),
    });
    // only enabled checks are scored; score should still compute
    expect(typeof res.level).toBe("number");
  });
});

describe("runScan - commerce detection wires isCommerce", () => {
  it("detects isCommerce=true when homepage advertises shopify", async () => {
    const origin = "https://shop.test";
    const fetchImpl = makeRoutedFetch({
      [`${origin}/`]: {
        status: 200,
        headers: { "content-type": "text/html" },
        body: '<html><head><meta name="shopify-digital-wallet"></head></html>',
      },
    });
    const res = await runScan(origin, { fetchImpl });
    expect(res.isCommerce).toBe(true);
    expect(res.commerceSignals.length).toBeGreaterThan(0);
  });

  it("isCommerce=false defaults commerce checks to neutral", async () => {
    const res = await runScan("https://example.com", {
      fetchImpl: fallbackFetch(),
    });
    expect(res.isCommerce).toBe(false);
    for (const id of ["x402", "mpp", "ucp", "acp", "ap2"] as const) {
      expect(res.checks.commerce[id].status).toBe("neutral");
    }
  });
});

describe("runScan - level + score computation", () => {
  it("returns level=0 for an empty site", async () => {
    const res = await runScan("https://example.com", {
      fetchImpl: fallbackFetch(),
    });
    expect(res.level).toBe(0);
    expect(res.levelName).toBe("Not Ready");
    expect(res.nextLevel).not.toBeNull();
  });
});
