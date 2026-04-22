/**
 * Oracle-driven tests for checkContentSignals.
 *
 * Uses the 5 real scan fixtures. The contentSignals check shares the
 * GET /robots.txt fetch with robotsTxt and robotsTxtAiRules. We verify the
 * fixture parse results (including signal counts for vercel + cf-dev).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScanContext } from "@/lib/engine/context";
import { CheckResultSchema } from "@/lib/schema";
import { checkContentSignals } from "@/lib/engine/checks/content-signals";

interface OracleStep {
  readonly action: string;
  readonly label: string;
  readonly finding: { readonly outcome: string; readonly summary: string };
  readonly request?: { readonly url: string; readonly method: string };
  readonly response?: {
    readonly status: number;
    readonly statusText?: string;
    readonly headers?: Record<string, string>;
    readonly bodyPreview?: string;
  };
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
    oracle: json.checks.botAccessControl.contentSignals,
  };
}

const FIXTURES: Record<string, Fixture> = {
  "cf-dev": loadFixture("scan-cf-dev.json"),
  cf: loadFixture("scan-cf.json"),
  example: loadFixture("scan-example.json"),
  shopify: loadFixture("scan-shopify.json"),
  vercel: loadFixture("scan-vercel.json"),
};

function buildFetchFromOracle(oracle: OracleCheckResult): typeof fetch {
  const fetchStep = oracle.evidence.find((s) => s.action === "fetch");
  if (!fetchStep?.response) {
    throw new Error("oracle missing /robots.txt fetch evidence");
  }
  const response = fetchStep.response;
  return (async () =>
    new Response(response.bodyPreview ?? "", {
      status: response.status,
      statusText: response.statusText ?? (response.status === 200 ? "OK" : ""),
      headers: response.headers ?? {},
    })) as typeof fetch;
}

describe("checkContentSignals — oracle fixtures", () => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    it(`matches the ${name} oracle`, async () => {
      const ctx = createScanContext({
        url: fixture.url,
        fetchImpl: buildFetchFromOracle(fixture.oracle),
      });
      const result = await checkContentSignals(ctx);

      expect(CheckResultSchema.parse(result)).toEqual(result);
      expect(result.status).toBe(fixture.oracle.status);
      expect(result.message).toBe(fixture.oracle.message);

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

      if (fixture.oracle.details?.signalCount !== undefined) {
        expect(result.details?.signalCount).toBe(
          fixture.oracle.details.signalCount,
        );
      }
    });
  }
});

describe("checkContentSignals — edge cases", () => {
  it("parses a single wildcard Content-Signal directive", async () => {
    const body =
      "User-Agent: *\nContent-Signal: search=yes, ai-input=yes, ai-train=no\nAllow: /\n";
    const fetchImpl: typeof fetch = async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    const ctx = createScanContext({
      url: "https://signals.test",
      fetchImpl,
    });
    const result = await checkContentSignals(ctx);
    expect(result.status).toBe("pass");
    expect(result.details?.signalCount).toBe(1);
    const signals = result.details?.signals as Array<Record<string, unknown>>;
    expect(signals[0]).toMatchObject({
      userAgent: "*",
      aiTrain: "no",
      search: "yes",
      aiInput: "yes",
    });
  });

  it("fails when robots.txt has no Content-Signal directive", async () => {
    const body = "User-agent: *\nAllow: /\n";
    const fetchImpl: typeof fetch = async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    const ctx = createScanContext({
      url: "https://plain.test",
      fetchImpl,
    });
    const result = await checkContentSignals(ctx);
    expect(result.status).toBe("fail");
    expect(result.message).toMatch(/No Content Signals/);
  });

  it("fails when robots.txt is missing", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("Not found", {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "text/html" },
      });
    const ctx = createScanContext({
      url: "https://noroots.test",
      fetchImpl,
    });
    const result = await checkContentSignals(ctx);
    expect(result.status).toBe("fail");
    expect(result.message).toMatch(/without robots\.txt/);
  });
});
