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
 *
 * Real-world pass path is synthesis-only (no oracle fixture captures a
 * passing api-catalog). Replace with captured fixture when available.
 */

import { describe, expect, it } from "vitest";

import {
  ALL_SITES,
  expectCheckMatchesOracle,
  makeFetchStub,
  runCheckAgainstOracle,
  type OracleCheckLike,
} from "./_helpers/oracle";
import { createScanContext } from "@/lib/engine/context";
import { CheckResultSchema } from "@/lib/schema";

import { checkApiCatalog } from "@/lib/engine/checks/api-catalog";

// ---------------------------------------------------------------------------
// Oracle round-trip
// ---------------------------------------------------------------------------

function getOracleEntry(raw: unknown): OracleCheckLike {
  return (raw as { checks: { discovery: { apiCatalog: OracleCheckLike } } })
    .checks.discovery.apiCatalog;
}

describe("checkApiCatalog — oracle fixtures", () => {
  for (const site of ALL_SITES) {
    it(`matches the ${site} oracle`, async () => {
      const { result, oracle, origin, calls } = await runCheckAgainstOracle({
        site,
        getOracleEntry,
        runCheck: checkApiCatalog,
      });

      expect(() => CheckResultSchema.parse(result)).not.toThrow();
      expectCheckMatchesOracle(result, oracle);

      expect(calls).toEqual(
        expect.arrayContaining([`${origin}/.well-known/api-catalog`]),
      );
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

  it("fails when 200 is returned with invalid JSON body", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://example.com/.well-known/api-catalog": {
        status: 200,
        headers: { "content-type": "application/linkset+json" },
        body: "<not json>",
      },
    });
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkApiCatalog(ctx);
    expect(result.status).toBe("fail");
  });

  it("fails when 200 JSON body is returned with wrong content-type", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://example.com/.well-known/api-catalog": {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ linkset: [{ anchor: "x" }] }),
      },
    });
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
