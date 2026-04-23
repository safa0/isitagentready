/**
 * Oracle-driven tests for checkOauthDiscovery.
 *
 * Spec (FINDINGS §3 / §9):
 *   Probe: GET /.well-known/oauth-authorization-server
 *          GET /.well-known/openid-configuration
 *   Pass: Either returns 200 JSON with `issuer` + `authorization_endpoint`.
 *
 * Oracle observations across 5 fixtures:
 *   - vercel: both endpoints return 200 JSON → status "pass", 5 evidence steps
 *     (fetch + validate) * 2 + conclude.
 *   - cf-dev / cf / example / shopify: both 404 → status "fail", 3 steps
 *     (fetch + fetch + conclude).
 *
 * Oracle evidence ordering varies across fixtures (some probe oauth-auth-server
 * first, others probe openid-configuration first). We normalise by checking
 * the set of labels rather than sequence, while still asserting length and
 * finding outcomes.
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

import { checkOauthDiscovery } from "@/lib/engine/checks/oauth-discovery";

// ---------------------------------------------------------------------------
// Oracle round-trip
// ---------------------------------------------------------------------------

function getOracle(site: OracleSite) {
  const oracle = loadOracle(site);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return oracle.raw.checks.discovery.oauthDiscovery as any;
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
  const result = await checkOauthDiscovery(ctx);
  return { result, oracle: check, calls: stub.calls };
}

describe("checkOauthDiscovery — oracle fixtures", () => {
  for (const site of ALL_SITES) {
    it(`matches the ${site} oracle`, async () => {
      const { result, oracle, calls } = await runAgainstOracle(site);

      expect(() => CheckResultSchema.parse(result)).not.toThrow();

      expect(result.status).toBe(oracle.status);
      expect(result.message).toBe(oracle.message);
      expect(result.evidence).toHaveLength(oracle.evidence.length);

      // Both well-known paths must always be probed regardless of order.
      const origin = new URL(oracle.url).origin;
      expect(calls).toEqual(
        expect.arrayContaining([
          `${origin}/.well-known/oauth-authorization-server`,
          `${origin}/.well-known/openid-configuration`,
        ]),
      );

      // Terminal step is the Conclusion.
      const last = result.evidence[result.evidence.length - 1]!;
      expect(last.action).toBe("conclude");
      expect(last.label).toBe("Conclusion");
      expect(last.finding.outcome).toBe(
        oracle.evidence[oracle.evidence.length - 1].finding.outcome,
      );

      // The set of labels should match the oracle's set (order-independent).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const oracleLabels = oracle.evidence.map((s: any) => s.label).sort();
      const actualLabels = result.evidence.map((s) => s.label).sort();
      expect(actualLabels).toEqual(oracleLabels);

      if (oracle.details?.source !== undefined) {
        expect(result.details?.source).toBe(oracle.details.source);
      }
      if (oracle.details?.issuer !== undefined) {
        expect(result.details?.issuer).toBe(oracle.details.issuer);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

const JSON_HEADERS = { "content-type": "application/json" };

describe("checkOauthDiscovery — edge cases", () => {
  it("passes when only openid-configuration responds", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://example.com/.well-known/oauth-authorization-server": {
        status: 404,
        headers: { "content-type": "text/plain" },
      },
      "https://example.com/.well-known/openid-configuration": {
        status: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({
          issuer: "https://example.com",
          authorization_endpoint: "https://example.com/oauth/authorize",
          token_endpoint: "https://example.com/oauth/token",
          jwks_uri: "https://example.com/.well-known/jwks",
        }),
      },
    });
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkOauthDiscovery(ctx);
    expect(result.status).toBe("pass");
  });

  it("fails when both endpoints return 404", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://example.com/.well-known/oauth-authorization-server": {
        status: 404,
        headers: {},
      },
      "https://example.com/.well-known/openid-configuration": {
        status: 404,
        headers: {},
      },
    });
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkOauthDiscovery(ctx);
    expect(result.status).toBe("fail");
  });

  it("fails when 200 JSON is returned but required fields are missing", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://example.com/.well-known/oauth-authorization-server": {
        status: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({ foo: "bar" }),
      },
      "https://example.com/.well-known/openid-configuration": {
        status: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({ foo: "bar" }),
      },
    });
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkOauthDiscovery(ctx);
    expect(result.status).toBe("fail");
  });

  it("fails when responses are 200 but not JSON", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://example.com/.well-known/oauth-authorization-server": {
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<html></html>",
      },
      "https://example.com/.well-known/openid-configuration": {
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<html></html>",
      },
    });
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkOauthDiscovery(ctx);
    expect(result.status).toBe("fail");
  });
});
