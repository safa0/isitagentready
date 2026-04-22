/**
 * Oracle-driven tests for checkMarkdownNegotiation.
 *
 * Each of the 5 real scan fixtures in `research/raw/` contains an oracle entry
 * for `contentAccessibility.markdownNegotiation`. We build a `fetchImpl` stub
 * that returns the exact response the oracle recorded, drive the check against
 * the shared scan context, and assert the produced `CheckResult` matches the
 * oracle's {status, message, evidence[].action/label/finding.outcome}.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScanContext } from "@/lib/engine/context";
import { CheckResultSchema } from "@/lib/schema";
import { checkMarkdownNegotiation } from "@/lib/engine/checks/markdown-negotiation";

// ---------------------------------------------------------------------------
// Fixture loader
// ---------------------------------------------------------------------------

interface OracleResponse {
  readonly status: number;
  readonly statusText?: string;
  readonly headers?: Record<string, string>;
  readonly bodyPreview?: string;
}

interface OracleStep {
  readonly action: string;
  readonly label: string;
  readonly finding: { readonly outcome: string; readonly summary: string };
  readonly request?: { readonly url: string; readonly method: string };
  readonly response?: OracleResponse;
}

interface OracleCheckResult {
  readonly status: "pass" | "fail" | "neutral";
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly evidence: OracleStep[];
}

interface Fixture {
  readonly url: string;
  readonly oracle: OracleCheckResult;
}

function loadFixture(name: string): Fixture {
  const file = path.join(process.cwd(), "research", "raw", name);
  const json = JSON.parse(readFileSync(file, "utf8"));
  return {
    url: json.url,
    oracle: json.checks.contentAccessibility.markdownNegotiation,
  };
}

const FIXTURES: Record<string, Fixture> = {
  "cf-dev": loadFixture("scan-cf-dev.json"),
  cf: loadFixture("scan-cf.json"),
  example: loadFixture("scan-example.json"),
  shopify: loadFixture("scan-shopify.json"),
  vercel: loadFixture("scan-vercel.json"),
};

// ---------------------------------------------------------------------------
// Build a fetch stub driven by the oracle's recorded homepage response
// ---------------------------------------------------------------------------

function buildFetchFromOracle(oracle: OracleCheckResult): typeof fetch {
  const fetchStep = oracle.evidence.find((s) => s.action === "fetch");
  if (!fetchStep?.response) {
    throw new Error("oracle missing homepage fetch evidence");
  }
  const response = fetchStep.response;
  return (async () =>
    new Response(response.bodyPreview ?? "", {
      status: response.status,
      statusText: response.statusText ?? "OK",
      headers: response.headers ?? {},
    })) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Oracle round-trip
// ---------------------------------------------------------------------------

describe("checkMarkdownNegotiation — oracle fixtures", () => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    it(`matches the ${name} oracle`, async () => {
      const ctx = createScanContext({
        url: fixture.url,
        fetchImpl: buildFetchFromOracle(fixture.oracle),
      });
      const result = await checkMarkdownNegotiation(ctx);

      // shape
      expect(CheckResultSchema.parse(result)).toEqual(result);

      // headline
      expect(result.status).toBe(fixture.oracle.status);
      expect(result.message).toBe(fixture.oracle.message);

      // details (contentType) when present in oracle
      if (fixture.oracle.details?.contentType !== undefined) {
        expect(result.details?.contentType).toBe(
          fixture.oracle.details.contentType,
        );
      }

      // evidence: actions + labels + finding outcomes must align
      const oracleActions = fixture.oracle.evidence.map((s) => s.action);
      const actualActions = result.evidence.map((s) => s.action);
      expect(actualActions).toEqual(oracleActions);

      for (let i = 0; i < fixture.oracle.evidence.length; i++) {
        const want = fixture.oracle.evidence[i]!;
        const got = result.evidence[i]!;
        expect(got.label).toBe(want.label);
        expect(got.finding.outcome).toBe(want.finding.outcome);
        expect(got.finding.summary).toBe(want.finding.summary);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("checkMarkdownNegotiation — edge cases", () => {
  it("sends Accept: text/markdown on the homepage request", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls.push(init ?? {});
      return new Response("# hi", {
        status: 200,
        headers: { "content-type": "text/markdown; charset=utf-8" },
      });
    };
    const ctx = createScanContext({
      url: "https://example.com",
      fetchImpl,
    });
    await checkMarkdownNegotiation(ctx);
    expect(calls).toHaveLength(1);
    const headers = calls[0]!.headers as Record<string, string>;
    // Header key casing is preserved as passed to fetch.
    const lookup = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    expect(lookup["accept"]).toBe("text/markdown");
  });

  it("treats transport errors as fail", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("ENOTFOUND");
    };
    const ctx = createScanContext({
      url: "https://never-resolves.test",
      fetchImpl,
    });
    const result = await checkMarkdownNegotiation(ctx);
    expect(result.status).toBe("fail");
    // terminal step is a conclusion with negative outcome
    const last = result.evidence[result.evidence.length - 1]!;
    expect(last.action).toBe("conclude");
    expect(last.finding.outcome).toBe("negative");
  });

  it("passes when content-type is exactly text/markdown (no charset)", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("# hi", {
        status: 200,
        headers: { "content-type": "text/markdown" },
      });
    const ctx = createScanContext({
      url: "https://example.com",
      fetchImpl,
    });
    const result = await checkMarkdownNegotiation(ctx);
    expect(result.status).toBe("pass");
    expect(result.details?.contentType).toBe("text/markdown");
  });

  it("fails when server returns 200 but text/html", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("<html></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    const ctx = createScanContext({
      url: "https://example.com",
      fetchImpl,
    });
    const result = await checkMarkdownNegotiation(ctx);
    expect(result.status).toBe("fail");
    expect(result.details?.contentType).toBe("text/html");
  });
});
