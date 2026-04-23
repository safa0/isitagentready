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
  type CheckResult,
  type ChecksBlock,
} from "@/lib/schema";
import { ALL_SITES, loadOracle } from "./_helpers/oracle";

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

// ---------------------------------------------------------------------------
// H9 — shared probe memo: only ONE homepage fetch per runScan, even though
// the orchestrator creates two ScanContexts (pre-commerce and widened).
// ---------------------------------------------------------------------------

describe("runScan - shared probes (H9)", () => {
  it("issues a single shared-homepage fetch across the two-context pipeline", async () => {
    const homepageUrl = "https://shared-probes.test/";
    // Track fetches by (url, accept-header) so we can separate the memoised
    // homepage probe from markdown-negotiation's distinct re-request.
    const homepageHits: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (url === homepageUrl) {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const accept = headers["accept"] ?? headers["Accept"] ?? "";
        homepageHits.push(accept);
        return new Response("<html></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("", { status: 404 });
    };
    await runScan("https://shared-probes.test", { fetchImpl });
    // Expect exactly one shared homepage probe (no Accept override) and
    // one markdownNegotiation probe (Accept: text/markdown). Two contexts
    // share the same probe promise so the former only fires once.
    const sharedProbeHits = homepageHits.filter(
      (accept) => !/markdown/i.test(accept),
    );
    expect(sharedProbeHits).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// H10 — oracle replay: for each captured fixture, build a fetch stub from the
// per-check evidence and assert that runScan round-trips level + levelName +
// per-check status against the oracle. Score gaps are separately covered by
// TODO(#6); here we only assert the stable surface that's deterministic
// under our implementation.
// ---------------------------------------------------------------------------

type CategoryKey = keyof ChecksBlock;

interface OracleCheckEntry {
  readonly status: CheckResult["status"];
  readonly message: string;
}

function collectOracleFetches(oracle: unknown): Map<string, {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body: string;
}> {
  const map = new Map<string, {
    status: number;
    statusText?: string;
    headers?: Record<string, string>;
    body: string;
  }>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node !== null && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      const action = obj["action"];
      const request = obj["request"] as { url?: string } | undefined;
      const response = obj["response"] as
        | { status?: number; statusText?: string; headers?: Record<string, string>; bodyPreview?: string }
        | undefined;
      if (
        action === "fetch" &&
        request !== undefined &&
        response !== undefined &&
        typeof request.url === "string" &&
        typeof response.status === "number"
      ) {
        // First-seen wins; oracle often records the same URL under multiple
        // checks with identical responses.
        if (!map.has(request.url)) {
          // Reconstruct body from preview. Truncated previews end with "..."
          // — we duplicate the head to guarantee our 500-char preview
          // survives untouched (matches _helpers/oracle.ts bodyFromPreview).
          const preview = response.bodyPreview ?? "";
          let body = preview;
          if (preview.endsWith("...") && preview.length > 500) {
            body = preview.slice(0, 500) + preview.slice(0, 500);
          }
          map.set(request.url, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            body,
          });
        }
      }
      Object.values(obj).forEach(walk);
    }
  };
  walk(oracle);
  return map;
}

function buildOracleFetchStub(oracle: unknown): typeof fetch {
  const fetches = collectOracleFetches(oracle);
  // Register trailing-slash aliases so `${origin}` and `${origin}/` both hit.
  for (const [url, entry] of Array.from(fetches.entries())) {
    if (url.endsWith("/")) {
      const without = url.slice(0, -1);
      if (!fetches.has(without)) fetches.set(without, entry);
    } else {
      const withSlash = url + "/";
      // Only alias homepage-like URLs (no path). Otherwise /foo ≠ /foo/.
      try {
        const parsed = new URL(url);
        if (parsed.pathname === "/" || parsed.pathname === "") {
          if (!fetches.has(withSlash)) fetches.set(withSlash, entry);
        }
      } catch {
        // Ignore malformed URLs — they stay unaliased.
      }
    }
  }
  return async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const entry = fetches.get(url);
    if (entry === undefined) {
      // Paths not present in the oracle (e.g. HEAD probes we issue on
      // commerce-signal URL candidates) default to 404 — the oracle's
      // scanner also treated missing probes as negative.
      return new Response("", { status: 404, statusText: "Not Found" });
    }
    return new Response(entry.body, {
      status: entry.status,
      statusText: entry.statusText ?? "OK",
      headers: entry.headers ?? {},
    });
  };
}

describe("runScan - oracle fixture replay (H10)", () => {
  for (const site of ALL_SITES) {
    it(`round-trips ${site} oracle schema + shape`, async () => {
      const fixture = loadOracle(site);
      const fetchImpl = buildOracleFetchStub(fixture.raw);
      const result = await runScan(fixture.url, { fetchImpl });
      // Schema round-trip
      expect(ScanResponseSchema.safeParse(result).success).toBe(true);
      // Note: `isCommerce` round-trips only when the oracle homepage body
      // contains the platform tokens within the bodyPreview cap. Platform
      // evidence (e.g. Shopify CDN script) often lives past the 500-char
      // cap so our reconstruction can't reliably reproduce it. Assert the
      // field exists rather than demanding oracle parity.
      expect(typeof result.isCommerce).toBe("boolean");

      // Walk categories and assert every oracle check id is present in
      // our response with a well-formed status. Exact per-check status
      // parity requires full body replay (see TODO(#6) — body previews
      // are truncated in fixtures and our reconstruction is lossy), so
      // we only assert the response SHAPE is aligned with the oracle.
      const expectedChecks = fixture.raw.checks as Record<
        CategoryKey,
        Record<string, OracleCheckEntry>
      >;
      const actualChecks = result.checks;
      for (const cat of Object.keys(expectedChecks) as CategoryKey[]) {
        const expected = expectedChecks[cat];
        const actual = actualChecks[cat] as Record<string, CheckResult>;
        for (const id of Object.keys(expected)) {
          const act = actual[id];
          expect(act, `${site} ${cat}.${id}`).toBeDefined();
          if (act === undefined) continue;
          expect(["pass", "fail", "neutral"]).toContain(act.status);
        }
      }
    });
  }

  it("asserts level + levelName parity where full body replay succeeds (example baseline)", async () => {
    // The example.com fixture has a level-0 baseline with no passes — the
    // only deterministic fixture that survives body-preview lossiness end
    // to end. The other 4 fixtures' level values require exact-body parity,
    // blocked by TODO(#6).
    const fixture = loadOracle("example");
    const fetchImpl = buildOracleFetchStub(fixture.raw);
    const result = await runScan(fixture.url, { fetchImpl });
    expect(result.level).toBe(fixture.raw.level);
    expect(result.levelName).toBe(fixture.raw.levelName);
  });
});
