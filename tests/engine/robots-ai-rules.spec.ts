/**
 * Oracle-driven tests for checkRobotsTxtAiRules.
 *
 * Uses the 5 real scan fixtures. The robotsTxtAiRules check reuses the
 * GET /robots.txt fetch, so our fetch stub handles that URL specifically and
 * returns the oracle's recorded response (including bodyPreview as body).
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createScanContext } from "@/lib/engine/context";
import { CheckResultSchema } from "@/lib/schema";
import { checkRobotsTxtAiRules } from "@/lib/engine/checks/robots-ai-rules";

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
  const fileUrl = new URL(`../../research/raw/${name}`, import.meta.url);
  const json = JSON.parse(readFileSync(fileUrl, "utf8"));
  return {
    url: json.url,
    oracle: json.checks.botAccessControl.robotsTxtAiRules,
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
  const expectedUrl = fetchStep.request?.url;
  // Normalise via the WHATWG URL parser so trivial cosmetic differences do
  // not break the match (see markdown-negotiation.spec.ts for rationale).
  const expectedHref =
    expectedUrl !== undefined ? new URL(expectedUrl).href : undefined;
  const response = fetchStep.response;
  return (async (input) => {
    const requestedRaw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const requestedHref = new URL(requestedRaw).href;
    if (expectedHref !== undefined && requestedHref !== expectedHref) {
      throw new Error(
        `unexpected fetch URL: got ${requestedHref}, expected ${expectedHref}`,
      );
    }
    return new Response(response.bodyPreview ?? "", {
      status: response.status,
      statusText: response.statusText ?? (response.status === 200 ? "OK" : ""),
      headers: response.headers ?? {},
    });
  }) as typeof fetch;
}

describe("checkRobotsTxtAiRules — oracle fixtures", () => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    it(`matches the ${name} oracle`, async () => {
      const ctx = createScanContext({
        url: fixture.url,
        fetchImpl: buildFetchFromOracle(fixture.oracle),
      });
      const result = await checkRobotsTxtAiRules(ctx);

      expect(() => CheckResultSchema.parse(result)).not.toThrow();
      expect(result.status).toBe(fixture.oracle.status);
      expect(result.message).toBe(fixture.oracle.message);

      const oracleActions = fixture.oracle.evidence.map((s) => s.action);
      const actualActions = result.evidence.map((s) => s.action);
      expect(actualActions).toEqual(oracleActions);
      expect(result.evidence).toHaveLength(fixture.oracle.evidence.length);

      for (let i = 0; i < fixture.oracle.evidence.length; i++) {
        const want = fixture.oracle.evidence[i]!;
        const got = result.evidence[i]!;
        expect(got.label).toBe(want.label);
        expect(got.finding.outcome).toBe(want.finding.outcome);
        expect(got.finding.summary).toBe(want.finding.summary);
      }

      // fixtures all have a checkedBots list
      if (Array.isArray(fixture.oracle.details?.checkedBots)) {
        expect(result.details?.checkedBots).toEqual(
          fixture.oracle.details.checkedBots,
        );
      }
    });
  }
});

describe("checkRobotsTxtAiRules — edge cases", () => {
  it("passes when robots.txt has an explicit AI-bot User-agent group", async () => {
    const body =
      "User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n";
    const fetchImpl: typeof fetch = async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    const ctx = createScanContext({
      url: "https://ai-aware.test",
      fetchImpl,
    });
    const result = await checkRobotsTxtAiRules(ctx);
    expect(result.status).toBe("pass");
    // details should reflect that AI-specific agents were found
    expect(Array.isArray(result.details?.foundBots)).toBe(true);
    expect((result.details?.foundBots as string[]).includes("gptbot")).toBe(
      true,
    );
  });

  it("parses multiple UA tokens on a single line (comma separated)", async () => {
    const body = "User-agent: GPTBot, ChatGPT-User\nDisallow: /\n";
    const fetchImpl: typeof fetch = async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    const ctx = createScanContext({
      url: "https://multi-ua-comma.test",
      fetchImpl,
    });
    const result = await checkRobotsTxtAiRules(ctx);
    expect(result.status).toBe("pass");
    const found = result.details?.foundBots as string[];
    expect(found).toEqual(expect.arrayContaining(["gptbot", "chatgpt-user"]));
  });

  it("parses multiple UA tokens on a single line (whitespace separated)", async () => {
    const body = "User-agent: GPTBot ChatGPT-User\nDisallow: /\n";
    const fetchImpl: typeof fetch = async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    const ctx = createScanContext({
      url: "https://multi-ua-ws.test",
      fetchImpl,
    });
    const result = await checkRobotsTxtAiRules(ctx);
    expect(result.status).toBe("pass");
    const found = result.details?.foundBots as string[];
    expect(found).toEqual(expect.arrayContaining(["gptbot", "chatgpt-user"]));
  });

  it("fails when robots.txt is missing (404)", async () => {
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
    const result = await checkRobotsTxtAiRules(ctx);
    expect(result.status).toBe("fail");
    expect(result.message).toMatch(/robots\.txt/);
  });

  it("fails on transport error", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const ctx = createScanContext({
      url: "https://down.test",
      fetchImpl,
    });
    const result = await checkRobotsTxtAiRules(ctx);
    expect(result.status).toBe("fail");
  });
});
