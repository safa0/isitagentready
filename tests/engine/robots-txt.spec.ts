/**
 * Failing specs for the `robotsTxt` check.
 *
 * Oracle: `research/raw/scan-*.json` → `checks.discoverability.robotsTxt`.
 * Reference: `research/FINDINGS.md` §9.
 *
 * Pass criterion (per FINDINGS §9):
 *   GET /robots.txt → 200 + Content-Type: text/plain + not a soft-404
 *   + body contains at least one valid `User-agent:` directive.
 *
 * The check function under test has NOT been implemented yet. These specs
 * intentionally fail at module-resolution time until Phase 1 impl-A ships
 * `lib/engine/checks/robots-txt.ts`.
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

// Import the not-yet-implemented check. This import is expected to FAIL with
// a module-not-found error until the implementer creates the file.
import { checkRobotsTxt } from "@/lib/engine/checks/robots-txt";

// ---------------------------------------------------------------------------
// Spec harness: run the check against each fixture's robots.txt response
// ---------------------------------------------------------------------------

async function runAgainstOracle(site: OracleSite) {
  const oracle = loadOracle(site);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const robotsOracle = oracle.raw.checks.discoverability.robotsTxt as any;

  // The oracle evidence always starts with the GET /robots.txt fetch. Extract
  // its response envelope so the stub replays the real wire format.
  const fetchStep = robotsOracle.evidence.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (s: any) => s.action === "fetch" && s.label === "GET /robots.txt",
  );
  if (fetchStep === undefined) {
    throw new Error(
      `fixture ${site}: no GET /robots.txt fetch step found`,
    );
  }

  // The recorded bodyPreview is truncated and may not itself contain a
  // User-agent directive (e.g. cf-dev's preview is an ASCII-art header
  // comment). The oracle still reports pass because the full body does —
  // so when the fixture expects pass, append a valid User-agent line to
  // the stub body.
  const preview = fetchStep.response.bodyPreview as string | undefined;
  const baseBody = bodyFromPreview(preview);
  const stubBody =
    robotsOracle.status === "pass"
      ? `${baseBody}\nUser-agent: *\nAllow: /\n`
      : baseBody;

  const robotsUrl = `${oracle.origin}/robots.txt`;
  const { fetchImpl } = makeFetchStub({
    [robotsUrl]: {
      status: fetchStep.response.status,
      statusText: fetchStep.response.statusText,
      headers: fetchStep.response.headers,
      body: stubBody,
    },
  });

  const ctx = createScanContext({
    url: oracle.origin,
    fetchImpl,
  });

  const result = await checkRobotsTxt(ctx);
  return { oracle: robotsOracle, result };
}

// ---------------------------------------------------------------------------
// Per-site oracle round-trip tests
// ---------------------------------------------------------------------------

describe("robotsTxt", () => {
  it.each(ALL_SITES)("%s: round-trips against the fixture oracle", async (site) => {
    const { oracle, result } = await runAgainstOracle(site);

    // Result validates against the public CheckResult schema.
    expect(CheckResultSchema.safeParse(result).success).toBe(true);

    // And matches the fixture's recorded check output structurally.
    expectCheckMatchesOracle(result, oracle);
  });

  it("cf-dev: passes with content-signals body and records parse/conclude steps", async () => {
    const { result } = await runAgainstOracle("cf-dev");
    expect(result.status).toBe("pass");
    expect(result.message).toBe("robots.txt exists with valid format");
    expect(result.evidence.map((s: EvidenceStep) => s.action)).toEqual([
      "fetch",
      "parse",
      "conclude",
    ]);
  });

  it("example: fails with a 404 and records a single fetch+conclude pair", async () => {
    const { result } = await runAgainstOracle("example");
    expect(result.status).toBe("fail");
    expect(result.message).toBe("robots.txt not found");
    // Per oracle: no "parse" step on failure.
    expect(result.evidence.map((s: EvidenceStep) => s.action)).toEqual(["fetch", "conclude"]);
  });
});

// ---------------------------------------------------------------------------
// Edge cases (not present in oracle fixtures but required by FINDINGS §9)
// ---------------------------------------------------------------------------

describe("robotsTxt — edge cases", () => {
  it("treats HTML responses as a soft-404 and fails", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://soft404.test/robots.txt": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html" },
        body: "<!doctype html><html><body>Not found</body></html>",
      },
    });
    const ctx = createScanContext({
      url: "https://soft404.test",
      fetchImpl,
    });
    const result = await checkRobotsTxt(ctx);

    expect(result.status).toBe("fail");
    expect(CheckResultSchema.safeParse(result).success).toBe(true);
    // Final step must be a conclude with a negative finding.
    const last = result.evidence.at(-1)!;
    expect(last.action).toBe("conclude");
    expect(last.finding.outcome).toBe("negative");
  });

  it("fails gracefully when /robots.txt returns 200 text/plain but no User-agent directive", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://no-ua.test/robots.txt": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/plain" },
        body: "# Just a comment, no directives\nSitemap: https://no-ua.test/sitemap.xml\n",
      },
    });
    const ctx = createScanContext({
      url: "https://no-ua.test",
      fetchImpl,
    });
    const result = await checkRobotsTxt(ctx);

    expect(result.status).toBe("fail");
    // Fetch succeeded, so a parse step should exist.
    expect(result.evidence.some((s: EvidenceStep) => s.action === "parse")).toBe(true);
    const parseStep = result.evidence.find((s: EvidenceStep) => s.action === "parse")!;
    expect(parseStep.finding.outcome).toBe("negative");
  });

  it("reports a fail (not a throw) when the origin is unreachable", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://dead.test/robots.txt": new Error("ENOTFOUND dead.test"),
    });
    const ctx = createScanContext({
      url: "https://dead.test",
      fetchImpl,
    });
    const result = await checkRobotsTxt(ctx);

    expect(result.status).toBe("fail");
    expect(CheckResultSchema.safeParse(result).success).toBe(true);
    const fetchStep = result.evidence.find((s: EvidenceStep) => s.action === "fetch")!;
    // Transport error → response omitted per context.ts contract.
    expect(fetchStep.response).toBeUndefined();
    expect(fetchStep.finding.outcome).toBe("negative");
  });

  // Exercises the transport-error fallback arm where `outcome.error` is falsy
  // (empty string). Matches the same shape as the link-headers transport spec.
  it("records the fallback summary when a transport error has no message", async () => {
    const emptyErr = new Error("");
    const { fetchImpl } = makeFetchStub({
      "https://silent.test/robots.txt": emptyErr,
    });
    const ctx = createScanContext({ url: "https://silent.test", fetchImpl });
    const result = await checkRobotsTxt(ctx);
    expect(result.status).toBe("fail");
    const fetchStep = result.evidence.find(
      (s: EvidenceStep) => s.action === "fetch",
    )!;
    expect(fetchStep.finding.summary).toBe(
      "Request failed with no response",
    );
  });

  it("memoises /robots.txt via ctx.getRobotsTxt (single upstream fetch)", async () => {
    const { fetchImpl, calls } = makeFetchStub({
      "https://memo.test/robots.txt": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/plain" },
        body: "User-agent: *\nAllow: /\n",
      },
    });
    const ctx = createScanContext({
      url: "https://memo.test",
      fetchImpl,
    });

    // Simulate downstream checks (robotsTxtAiRules, sitemap, contentSignals)
    // sharing the same robots.txt body via the memoised helper.
    await ctx.getRobotsTxt();
    await checkRobotsTxt(ctx);

    expect(calls.filter((u) => u.endsWith("/robots.txt"))).toHaveLength(1);
  });
});
