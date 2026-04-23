/**
 * Oracle-driven tests for checkOauthProtectedResource.
 *
 * Spec (FINDINGS §3 / §9):
 *   Probe: GET /              (to sniff WWW-Authenticate)
 *          GET /.well-known/oauth-protected-resource
 *   Pass: 200 JSON with a `resource` field.
 *
 * Oracle observations across 5 fixtures (all 5 fail):
 *   - 3 evidence steps in each: homepage fetch + well-known fetch + conclude.
 *   - Order varies per fixture (shopify probes well-known first, cf-dev
 *     homepage first). We tolerate both.
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

import { checkOauthProtectedResource } from "@/lib/engine/checks/oauth-protected-resource";

// ---------------------------------------------------------------------------
// Oracle round-trip
// ---------------------------------------------------------------------------

function getOracle(site: OracleSite) {
  const oracle = loadOracle(site);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return oracle.raw.checks.discovery.oauthProtectedResource as any;
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
  // The homepage URL in the oracle is recorded without trailing slash
  // (e.g. "https://example.com") but ctx.fetch("/") produces
  // "https://example.com/". Register both forms to keep the stub happy.
  const origin = new URL(oracle.url).origin;
  if (routes[origin] !== undefined) {
    routes[`${origin}/`] = routes[origin];
  }

  const stub = makeFetchStub(routes);
  const ctx = createScanContext({
    url: oracle.url,
    fetchImpl: stub.fetchImpl,
  });
  const result = await checkOauthProtectedResource(ctx);
  return { result, oracle: check, calls: stub.calls };
}

describe("checkOauthProtectedResource — oracle fixtures", () => {
  for (const site of ALL_SITES) {
    it(`matches the ${site} oracle`, async () => {
      const { result, oracle, calls } = await runAgainstOracle(site);

      expect(() => CheckResultSchema.parse(result)).not.toThrow();

      expect(result.status).toBe(oracle.status);
      expect(result.message).toBe(oracle.message);
      expect(result.evidence).toHaveLength(oracle.evidence.length);

      // Both paths probed.
      const origin = new URL(oracle.url).origin;
      // Homepage call may come in as either origin or origin/ — tolerate both.
      const sawHomepage = calls.some(
        (c) => c === origin || c === `${origin}/`,
      );
      expect(sawHomepage).toBe(true);
      expect(calls).toEqual(
        expect.arrayContaining([
          `${origin}/.well-known/oauth-protected-resource`,
        ]),
      );

      const last = result.evidence[result.evidence.length - 1]!;
      expect(last.action).toBe("conclude");
      expect(last.label).toBe("Conclusion");
    });
  }
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

const JSON_HEADERS = { "content-type": "application/json" };

describe("checkOauthProtectedResource — edge cases", () => {
  it("passes when well-known returns 200 JSON with `resource` field", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://example.com/": {
        status: 200,
        headers: { "content-type": "text/html" },
      },
      "https://example.com/.well-known/oauth-protected-resource": {
        status: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({
          resource: "https://example.com",
          authorization_servers: ["https://auth.example.com"],
        }),
      },
    });
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkOauthProtectedResource(ctx);
    expect(result.status).toBe("pass");
  });

  it("fails when well-known returns 200 JSON but no `resource` field", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://example.com/": {
        status: 200,
        headers: { "content-type": "text/html" },
      },
      "https://example.com/.well-known/oauth-protected-resource": {
        status: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({ foo: "bar" }),
      },
    });
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkOauthProtectedResource(ctx);
    expect(result.status).toBe("fail");
  });

  it("fails when well-known returns 404", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://example.com/": {
        status: 200,
        headers: { "content-type": "text/html" },
      },
      "https://example.com/.well-known/oauth-protected-resource": {
        status: 404,
        headers: {},
      },
    });
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkOauthProtectedResource(ctx);
    expect(result.status).toBe("fail");
  });

  it("fails gracefully on transport errors to well-known", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("ECONNRESET");
    };
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkOauthProtectedResource(ctx);
    expect(result.status).toBe("fail");
  });
});
