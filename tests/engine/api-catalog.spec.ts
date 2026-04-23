/**
 * Oracle-driven tests for checkApiCatalog.
 *
 * Spec (FINDINGS §3 / §9):
 *   Probe: GET /.well-known/api-catalog with
 *     `Accept: application/linkset+json, application/json`
 *   Pass: 200 + `application/linkset+json` + non-empty linkset array.
 *
 * Oracle observations across 5 fixtures (all 5 fail):
 *   - 2 evidence steps: fetch + conclude.
 *   - Request carries the Accept header verbatim.
 *   - Fail summary: "Server returned <code> -- API Catalog not found"
 *   - Conclude summary: "API Catalog not found".
 */

import { describe, expect, it } from "vitest";

import {
  ALL_SITES,
  loadOracle,
  makeFetchStub,
  type OracleSite,
  type StubHandler,
} from "./_helpers/oracle";
import { createScanContext } from "@/lib/engine/context";
import { CheckResultSchema } from "@/lib/schema";

import { checkApiCatalog } from "@/lib/engine/checks/api-catalog";

// ---------------------------------------------------------------------------
// Oracle round-trip
// ---------------------------------------------------------------------------

function getOracle(site: OracleSite) {
  const oracle = loadOracle(site);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return oracle.raw.checks.discovery.apiCatalog as any;
}

async function runAgainstOracle(site: OracleSite) {
  const oracle = loadOracle(site);
  const check = getOracle(site);

  const routes: Record<string, StubHandler> = {};
  for (const step of check.evidence) {
    if (step.action !== "fetch" || !step.request || !step.response) continue;
    routes[step.request.url] = {
      status: step.response.status,
      statusText: step.response.statusText,
      headers: step.response.headers ?? {},
      body: step.response.bodyPreview ?? "",
    };
  }

  const stub = makeFetchStub(routes);
  const ctx = createScanContext({
    url: oracle.url,
    fetchImpl: stub.fetchImpl,
  });
  const result = await checkApiCatalog(ctx);
  return { result, oracle: check, calls: stub.calls };
}

describe("checkApiCatalog — oracle fixtures", () => {
  for (const site of ALL_SITES) {
    it(`matches the ${site} oracle`, async () => {
      const { result, oracle, calls } = await runAgainstOracle(site);

      expect(() => CheckResultSchema.parse(result)).not.toThrow();

      expect(result.status).toBe(oracle.status);
      expect(result.message).toBe(oracle.message);
      expect(result.evidence).toHaveLength(oracle.evidence.length);

      const origin = new URL(oracle.url).origin;
      expect(calls).toEqual(
        expect.arrayContaining([`${origin}/.well-known/api-catalog`]),
      );

      // Oracle evidence is deterministic for this check (fetch + conclude).
      for (let i = 0; i < oracle.evidence.length; i++) {
        const want = oracle.evidence[i];
        const got = result.evidence[i]!;
        expect(got.action, `evidence[${i}].action`).toBe(want.action);
        expect(got.label, `evidence[${i}].label`).toBe(want.label);
        expect(got.finding.outcome, `evidence[${i}].finding.outcome`).toBe(
          want.finding.outcome,
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("checkApiCatalog — edge cases", () => {
  it("passes when well-known returns 200 linkset+json with entries", async () => {
    const linkset = {
      linkset: [
        {
          anchor: "https://example.com",
          "service-desc": [{ href: "https://example.com/openapi.json" }],
        },
      ],
    };
    const { fetchImpl } = makeFetchStub({
      "https://example.com/.well-known/api-catalog": {
        status: 200,
        headers: { "content-type": "application/linkset+json" },
        body: JSON.stringify(linkset),
      },
    });
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkApiCatalog(ctx);
    expect(result.status).toBe("pass");
  });

  it("fails when 200 linkset+json has an empty linkset[]", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://example.com/.well-known/api-catalog": {
        status: 200,
        headers: { "content-type": "application/linkset+json" },
        body: JSON.stringify({ linkset: [] }),
      },
    });
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkApiCatalog(ctx);
    expect(result.status).toBe("fail");
  });

  it("fails on 404", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://example.com/.well-known/api-catalog": {
        status: 404,
        headers: { "content-type": "text/html" },
      },
    });
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkApiCatalog(ctx);
    expect(result.status).toBe("fail");
  });

  it("fails gracefully on transport errors", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("ETIMEDOUT");
    };
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkApiCatalog(ctx);
    expect(result.status).toBe("fail");
  });

  it("sends Accept: application/linkset+json, application/json", async () => {
    const seen: Record<string, string> = {};
    const fetchImpl: typeof fetch = async (_url, init) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      for (const [k, v] of Object.entries(h)) {
        seen[k.toLowerCase()] = v;
      }
      return new Response("", { status: 404 });
    };
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    await checkApiCatalog(ctx);
    expect(seen["accept"]).toBe("application/linkset+json, application/json");
  });
});
