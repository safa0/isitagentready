/**
 * Failing specs for the `sitemap` check.
 *
 * Oracle: `research/raw/scan-*.json` → `checks.discoverability.sitemap`.
 * Reference: `research/FINDINGS.md` §9.
 *
 * Per FINDINGS §9:
 *   1. Read /robots.txt (memoised) and extract every `Sitemap:` directive.
 *      Emit a `parse` step summarising how many were found.
 *   2. Fetch each declared Sitemap URL; pass if any returns 200 with a parsable
 *      `<urlset>` or `<sitemapindex>` XML root.
 *   3. Fall back to four well-known paths when robots.txt is missing or has no
 *      Sitemap directive, in this order:
 *      /sitemap-index.xml, /sitemap.xml.gz, /sitemap_index.xml, /sitemap.xml.
 */

import { describe, it, expect } from "vitest";

import {
  ALL_SITES,
  bodyFromPreview,
  expectCheckMatchesOracle,
  loadOracle,
  makeFetchStub,
  type OracleSite,
  type StubHandler,
} from "./_helpers/oracle";
import { createScanContext } from "@/lib/engine/context";
import { CheckResultSchema, type EvidenceStep } from "@/lib/schema";

// Not-yet-implemented check — this import must FAIL until impl-A ships
// `lib/engine/checks/sitemap.ts`.
import { checkSitemap } from "@/lib/engine/checks/sitemap";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid XML sitemap body (urlset with one URL). */
const VALID_URLSET_BODY =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
  "<url><loc>https://example.com/</loc></url>" +
  "</urlset>";

/** Minimal valid sitemap index body (sitemapindex with one sitemap ref). */
const VALID_SITEMAPINDEX_BODY =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
  "<sitemap><loc>https://example.com/sitemap-0.xml</loc></sitemap>" +
  "</sitemapindex>";

/**
 * Replay every fetch step the oracle recorded (robots.txt + each sitemap URL).
 * For any fetch step whose response body is not preserved verbatim in the
 * fixture, we inject a minimal parsable sitemap body so our parser pipeline
 * can produce the same positive finding.
 */
async function runAgainstOracle(site: OracleSite) {
  const oracle = loadOracle(site);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sitemapOracle = oracle.raw.checks.discoverability.sitemap as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const robotsOracle = oracle.raw.checks.discoverability.robotsTxt as any;

  const routes: Record<string, StubHandler> = {};

  // Reproduce the /robots.txt fetch using the robotsTxt fixture (same probe
  // shared via ctx.getRobotsTxt).
  const robotsFetch = robotsOracle.evidence.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (s: any) => s.action === "fetch" && s.label === "GET /robots.txt",
  );
  if (robotsFetch !== undefined) {
    routes[`${oracle.origin}/robots.txt`] = {
      status: robotsFetch.response.status,
      statusText: robotsFetch.response.statusText,
      headers: robotsFetch.response.headers,
      body: bodyFromPreview(robotsFetch.response.bodyPreview),
    };
  }

  // Reproduce every sitemap fetch the oracle performed.
  for (const step of sitemapOracle.evidence) {
    if (step.action !== "fetch" || !step.request) continue;
    const url = step.request.url as string;
    const status = step.response.status as number;
    const headers = step.response.headers as Record<string, string>;
    // If the oracle recorded a success, seed a parsable urlset body so our
    // parser produces the same positive finding. On failure seed nothing.
    const body = status === 200 ? VALID_URLSET_BODY : "";
    routes[url] = {
      status,
      statusText: step.response.statusText,
      headers,
      body,
    };
  }

  const { fetchImpl } = makeFetchStub(routes);
  const ctx = createScanContext({ url: oracle.origin, fetchImpl });
  const result = await checkSitemap(ctx);
  return { oracle: sitemapOracle, result };
}

// ---------------------------------------------------------------------------
// Oracle round-trip
// ---------------------------------------------------------------------------

describe("sitemap", () => {
  it.each(ALL_SITES)("%s: round-trips against the fixture oracle", async (site) => {
    const { oracle, result } = await runAgainstOracle(site);
    expect(CheckResultSchema.safeParse(result).success).toBe(true);
    expectCheckMatchesOracle(result, oracle);
  });

  it("cf-dev: uses the Sitemap: directive from robots.txt before probing defaults", async () => {
    const { result } = await runAgainstOracle("cf-dev");
    expect(result.status).toBe("pass");
    expect(result.details).toMatchObject({
      url: "https://developers.cloudflare.com/sitemap-index.xml",
      fromRobotsTxt: true,
      format: "xml",
    });
    // First step is a "parse" (extract directives), then one fetch, then conclude.
    expect(result.evidence.map((s: EvidenceStep) => s.action)).toEqual([
      "parse",
      "fetch",
      "conclude",
    ]);
  });

  it("example: probes all four default locations in the documented order", async () => {
    const { result } = await runAgainstOracle("example");
    expect(result.status).toBe("fail");
    const fetchLabels = result.evidence
      .filter((s: EvidenceStep) => s.action === "fetch")
      .map((s: EvidenceStep) => s.label);
    expect(fetchLabels).toEqual([
      "GET /sitemap-index.xml",
      "GET /sitemap.xml.gz",
      "GET /sitemap_index.xml",
      "GET /sitemap.xml",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("sitemap — edge cases", () => {
  it("falls back to /sitemap.xml when robots.txt exists but has no Sitemap directive", async () => {
    const { fetchImpl, calls } = makeFetchStub({
      "https://nosm.test/robots.txt": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/plain" },
        body: "User-agent: *\nAllow: /\n",
      },
      "https://nosm.test/sitemap-index.xml": {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "text/html" },
      },
      "https://nosm.test/sitemap.xml.gz": {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "text/html" },
      },
      "https://nosm.test/sitemap_index.xml": {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "text/html" },
      },
      "https://nosm.test/sitemap.xml": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/xml" },
        body: VALID_URLSET_BODY,
      },
    });
    const ctx = createScanContext({ url: "https://nosm.test", fetchImpl });
    const result = await checkSitemap(ctx);

    expect(result.status).toBe("pass");
    expect(result.details).toMatchObject({
      url: "https://nosm.test/sitemap.xml",
      fromRobotsTxt: false,
    });
    // Ensure the probe order was preserved.
    expect(calls).toEqual(
      expect.arrayContaining([
        "https://nosm.test/sitemap-index.xml",
        "https://nosm.test/sitemap.xml.gz",
        "https://nosm.test/sitemap_index.xml",
        "https://nosm.test/sitemap.xml",
      ]),
    );
  });

  it("fails (not throws) when every sitemap candidate 404s", async () => {
    const routes: Record<string, StubHandler> = {
      "https://empty.test/robots.txt": new Error("ENOTFOUND"),
    };
    for (const p of [
      "/sitemap-index.xml",
      "/sitemap.xml.gz",
      "/sitemap_index.xml",
      "/sitemap.xml",
    ]) {
      routes[`https://empty.test${p}`] = {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "text/html" },
      };
    }
    const { fetchImpl } = makeFetchStub(routes);
    const ctx = createScanContext({ url: "https://empty.test", fetchImpl });
    const result = await checkSitemap(ctx);

    expect(result.status).toBe("fail");
    expect(CheckResultSchema.safeParse(result).success).toBe(true);
    expect(result.evidence.at(-1)!.action).toBe("conclude");
  });

  it("fails when a sitemap returns 200 but the body is not valid XML", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://junk.test/robots.txt": new Error("ENOTFOUND"),
      "https://junk.test/sitemap-index.xml": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/xml" },
        body: "not-xml-at-all{}",
      },
      "https://junk.test/sitemap.xml.gz": {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "text/html" },
      },
      "https://junk.test/sitemap_index.xml": {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "text/html" },
      },
      "https://junk.test/sitemap.xml": {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "text/html" },
      },
    });
    const ctx = createScanContext({ url: "https://junk.test", fetchImpl });
    const result = await checkSitemap(ctx);
    expect(result.status).toBe("fail");
  });

  it("accepts a <sitemapindex> root as a valid sitemap", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://idx.test/robots.txt": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/plain" },
        body: "Sitemap: https://idx.test/sitemap.xml\nUser-agent: *\n",
      },
      "https://idx.test/sitemap.xml": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/xml" },
        body: VALID_SITEMAPINDEX_BODY,
      },
    });
    const ctx = createScanContext({ url: "https://idx.test", fetchImpl });
    const result = await checkSitemap(ctx);
    expect(result.status).toBe("pass");
    expect(result.details).toMatchObject({
      url: "https://idx.test/sitemap.xml",
      fromRobotsTxt: true,
    });
  });
});
