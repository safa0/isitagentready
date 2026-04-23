/**
 * Oracle-driven tests for checkContentSignals.
 *
 * Uses the 5 real scan fixtures. The contentSignals check shares the
 * GET /robots.txt fetch with robotsTxt and robotsTxtAiRules. We verify the
 * fixture parse results (including signal counts for vercel + cf-dev).
 */

import { readFileSync } from "node:fs";
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
  // Use import.meta.url so path resolution does not depend on the test
  // runner's cwd — works uniformly in Vitest local runs and CI.
  const fileUrl = new URL(`../../research/raw/${name}`, import.meta.url);
  const json = JSON.parse(readFileSync(fileUrl, "utf8"));
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

/**
 * Build a robots.txt body from the oracle. The fixtures only capture the
 * first 500 chars as `bodyPreview`, so on fixtures where the oracle details
 * indicate Content-Signal directives that land past the truncation boundary
 * (notably scan-cf-dev.json), we splice synthetic directives back in using the
 * structured `details.signals` list so the parser can observe them.
 *
 * The returned fetch guards the requested URL: only the oracle's recorded
 * `/robots.txt` URL is allowed, other paths throw. This prevents silent
 * passes when a check is accidentally rewired.
 */
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
  let body = response.bodyPreview ?? "";
  const signals = oracle.details?.signals;
  if (Array.isArray(signals) && signals.length > 0) {
    const appendix: string[] = [];
    for (const s of signals as Array<{
      userAgent: string;
      path: string | null;
      aiTrain: string | null;
      search: string | null;
      aiInput: string | null;
    }>) {
      appendix.push("", `User-Agent: ${s.userAgent}`);
      if (s.path !== null && s.path !== undefined) {
        appendix.push(`Path: ${s.path}`);
      }
      const parts: string[] = [];
      if (s.search !== null && s.search !== undefined)
        parts.push(`search=${s.search}`);
      if (s.aiInput !== null && s.aiInput !== undefined)
        parts.push(`ai-input=${s.aiInput}`);
      if (s.aiTrain !== null && s.aiTrain !== undefined)
        parts.push(`ai-train=${s.aiTrain}`);
      appendix.push(`Content-Signal: ${parts.join(", ")}`);
    }
    // If the preview already contains a Content-Signal line, don't double up.
    if (!/^content-signal\s*:/im.test(body)) {
      body = `${body}\n${appendix.join("\n")}\n`;
    }
  }
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
    return new Response(body, {
      status: response.status,
      statusText: response.statusText ?? (response.status === 200 ? "OK" : ""),
      headers: response.headers ?? {},
    });
  }) as typeof fetch;
}

describe("checkContentSignals — oracle fixtures", () => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    it(`matches the ${name} oracle`, async () => {
      const ctx = createScanContext({
        url: fixture.url,
        fetchImpl: buildFetchFromOracle(fixture.oracle),
      });
      const result = await checkContentSignals(ctx);

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

  it("scopes Path: only to the directive immediately following", async () => {
    // Per the contentsignals.org draft: Path applies to ONE directive.
    // Here `/foo/*` should attach to signal #1 but NOT signal #2.
    const body = [
      "User-Agent: *",
      "Path: /foo/*",
      "Content-Signal: ai-train=no",
      "Content-Signal: ai-train=yes",
      "",
    ].join("\n");
    const fetchImpl: typeof fetch = async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    const ctx = createScanContext({
      url: "https://scope.test",
      fetchImpl,
    });
    const result = await checkContentSignals(ctx);
    expect(result.status).toBe("pass");
    const signals = result.details?.signals as Array<Record<string, unknown>>;
    expect(signals).toHaveLength(2);
    expect(signals[0]!.path).toBe("/foo/*");
    expect(signals[0]!.aiTrain).toBe("no");
    expect(signals[1]!.path).toBeNull();
    expect(signals[1]!.aiTrain).toBe("yes");
  });

  it("silently drops unrecognized signal values", async () => {
    // `search=maybe` is not `yes`/`no`, so the value is ignored and that key
    // stays null on the directive — the directive itself still records.
    const body =
      "User-Agent: *\nContent-Signal: search=maybe, ai-train=no\n";
    const fetchImpl: typeof fetch = async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    const ctx = createScanContext({
      url: "https://unknownval.test",
      fetchImpl,
    });
    const result = await checkContentSignals(ctx);
    expect(result.status).toBe("pass");
    const signals = result.details?.signals as Array<Record<string, unknown>>;
    expect(signals).toHaveLength(1);
    expect(signals[0]!.search).toBeNull();
    expect(signals[0]!.aiTrain).toBe("no");
  });

  it("skips Content-Signal lines with no key=value pairs", async () => {
    // Exercises the `continue` branch where split("=") yields only one part.
    const body = "User-Agent: *\nContent-Signal: yes\n";
    const fetchImpl: typeof fetch = async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    const ctx = createScanContext({
      url: "https://malformed.test",
      fetchImpl,
    });
    const result = await checkContentSignals(ctx);
    // The directive line still matched; it just has no resolved fields.
    expect(result.status).toBe("pass");
    const signals = result.details?.signals as Array<Record<string, unknown>>;
    expect(signals).toHaveLength(1);
    expect(signals[0]!.search).toBeNull();
    expect(signals[0]!.aiInput).toBeNull();
    expect(signals[0]!.aiTrain).toBeNull();
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
