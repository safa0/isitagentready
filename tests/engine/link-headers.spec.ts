/**
 * Failing specs for the `linkHeaders` check.
 *
 * Oracle: `research/raw/scan-*.json` → `checks.discoverability.linkHeaders`.
 * Reference: `research/FINDINGS.md` §9.
 *
 * Per FINDINGS §9:
 *   - GET / (homepage) and inspect the `Link:` response header.
 *   - Pass when at least one agent-useful relation is present; the set
 *     includes `api-catalog`, `service-doc`, `service-desc`, `describedby`,
 *     `llms.txt`, `llms-full.txt`, and `markdown` (RFC 8288 / RFC 9727 §3).
 *   - Fail when no Link header is returned at all, or when no registered
 *     agent-useful relation is present.
 */

import { describe, it, expect } from "vitest";

import {
  ALL_SITES,
  bodyFromPreview,
  expectCheckMatchesOracle,
  loadOracle,
  makeFetchStub,
  type OracleSite,
} from "./_helpers/oracle";
import { createScanContext } from "@/lib/engine/context";
import { CheckResultSchema, type EvidenceStep } from "@/lib/schema";

// Not-yet-implemented check; import fails until impl-A ships the file.
import { checkLinkHeaders } from "@/lib/engine/checks/link-headers";

// ---------------------------------------------------------------------------
// Oracle harness
// ---------------------------------------------------------------------------

async function runAgainstOracle(site: OracleSite) {
  const oracle = loadOracle(site);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const linkOracle = oracle.raw.checks.discoverability.linkHeaders as any;

  const fetchStep = linkOracle.evidence.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (s: any) => s.action === "fetch" && s.label === "GET /",
  );
  if (fetchStep === undefined) {
    throw new Error(`fixture ${site}: no GET / fetch step found`);
  }

  // The homepage fetch lives behind ctx.getHomepage(), which always targets
  // "/" — context normalises to "https://origin/". The oracle's request URL
  // omits the trailing slash, but the fetch stub needs the canonical form.
  const routes: Record<string, Parameters<typeof makeFetchStub>[0][string]> = {};
  const urlWithSlash = `${oracle.origin}/`;
  routes[urlWithSlash] = {
    status: fetchStep.response.status,
    statusText: fetchStep.response.statusText,
    headers: fetchStep.response.headers,
    body: bodyFromPreview(fetchStep.response.bodyPreview),
  };

  const { fetchImpl } = makeFetchStub(routes);
  const ctx = createScanContext({ url: oracle.origin, fetchImpl });
  const result = await checkLinkHeaders(ctx);
  return { oracle: linkOracle, result };
}

// ---------------------------------------------------------------------------
// Oracle round-trip
// ---------------------------------------------------------------------------

describe("linkHeaders", () => {
  it.each(ALL_SITES)("%s: round-trips against the fixture oracle", async (site) => {
    const { oracle, result } = await runAgainstOracle(site);
    expect(CheckResultSchema.safeParse(result).success).toBe(true);
    expectCheckMatchesOracle(result, oracle);
  });

  it("cf-dev: reports the service-doc relation in details", async () => {
    const { result } = await runAgainstOracle("cf-dev");
    expect(result.status).toBe("pass");
    expect(result.message).toBe(
      "Found agent-useful Link relations: service-doc",
    );
    expect(result.details).toMatchObject({
      relationsFound: [{ rel: "service-doc", href: "/api/" }],
      totalLinks: 1,
    });
    // Four-step evidence timeline on pass: fetch → parse → parse → conclude.
    expect(result.evidence.map((s: EvidenceStep) => s.action)).toEqual([
      "fetch",
      "parse",
      "parse",
      "conclude",
    ]);
  });

  it("cf: fails with two-step evidence when no Link header is returned", async () => {
    const { result } = await runAgainstOracle("cf");
    expect(result.status).toBe("fail");
    expect(result.message).toBe("No Link headers found on homepage");
    expect(result.evidence.map((s: EvidenceStep) => s.action)).toEqual([
      "fetch",
      "conclude",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("linkHeaders — edge cases", () => {
  it("passes when homepage advertises an api-catalog relation", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://api-cat.test/": {
        status: 200,
        statusText: "OK",
        headers: {
          "content-type": "text/html",
          link: '</.well-known/api-catalog>; rel="api-catalog"',
        },
        body: "<html/>",
      },
    });
    const ctx = createScanContext({ url: "https://api-cat.test", fetchImpl });
    const result = await checkLinkHeaders(ctx);
    expect(result.status).toBe("pass");
    expect(result.details).toMatchObject({
      relationsFound: [{ rel: "api-catalog", href: "/.well-known/api-catalog" }],
    });
  });

  it("passes when homepage advertises an llms.txt relation", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://llms.test/": {
        status: 200,
        statusText: "OK",
        headers: {
          "content-type": "text/html",
          link: '</llms.txt>; rel="llms.txt"',
        },
        body: "<html/>",
      },
    });
    const ctx = createScanContext({ url: "https://llms.test", fetchImpl });
    const result = await checkLinkHeaders(ctx);
    expect(result.status).toBe("pass");
    const rels = (result.details?.relationsFound as Array<{ rel: string }>).map(
      (r) => r.rel,
    );
    expect(rels).toContain("llms.txt");
  });

  it("fails when a Link header is present but no relation is agent-useful", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://noisy.test/": {
        status: 200,
        statusText: "OK",
        headers: {
          "content-type": "text/html",
          link: '</style.css>; rel="stylesheet", </icon.png>; rel="icon"',
        },
        body: "<html/>",
      },
    });
    const ctx = createScanContext({ url: "https://noisy.test", fetchImpl });
    const result = await checkLinkHeaders(ctx);
    expect(result.status).toBe("fail");
  });

  it("fails (not throws) when the homepage request errors", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://broken.test/": new Error("ECONNRESET"),
    });
    const ctx = createScanContext({ url: "https://broken.test", fetchImpl });
    const result = await checkLinkHeaders(ctx);
    expect(result.status).toBe("fail");
    expect(CheckResultSchema.safeParse(result).success).toBe(true);
    const fetchStep = result.evidence.find((s) => s.action === "fetch")!;
    expect(fetchStep.response).toBeUndefined();
  });

  it("parses multiple relations in a single comma-separated Link header", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://multi.test/": {
        status: 200,
        statusText: "OK",
        headers: {
          "content-type": "text/html",
          link:
            '</docs>; rel="service-doc", ' +
            '</openapi.json>; rel="service-desc", ' +
            '</about>; rel="describedby"',
        },
        body: "<html/>",
      },
    });
    const ctx = createScanContext({ url: "https://multi.test", fetchImpl });
    const result = await checkLinkHeaders(ctx);
    expect(result.status).toBe("pass");
    expect(result.details?.totalLinks).toBe(3);
    const rels = (
      result.details?.relationsFound as Array<{ rel: string }>
    ).map((r) => r.rel);
    expect(rels).toEqual(
      expect.arrayContaining(["service-doc", "service-desc", "describedby"]),
    );
  });
});
