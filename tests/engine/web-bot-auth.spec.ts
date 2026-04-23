/**
 * Oracle-driven tests for checkWebBotAuth.
 *
 * Spec (FINDINGS §3 / §9):
 *   Probe: GET /.well-known/http-message-signatures-directory
 *   Pass: 200 + JSON body with a non-empty `keys` array (RFC 7517 JWKS shape).
 *   Otherwise: NEUTRAL (informational). The check is never a hard failure —
 *   absence of Web Bot Auth is not grounds for denying agent-readiness.
 *
 * Oracle observations across 5 fixtures:
 *   - cf-dev / cf / example / vercel: 404 → status="neutral", 2 evidence steps
 *     (fetch + conclude) with `message` = "Web Bot Auth directory not found
 *     (informational only)".
 *   - shopify: 200 with a single JWK object (no `keys` wrapper) → status
 *     still "neutral", 3 evidence steps (fetch + validate + conclude), message
 *     says "missing required 'keys' array".
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

// Not-yet-implemented (module should not resolve until GREEN phase).
import { checkWebBotAuth } from "@/lib/engine/checks/web-bot-auth";

// ---------------------------------------------------------------------------
// Oracle round-trip
// ---------------------------------------------------------------------------

function getOracle(site: OracleSite) {
  const oracle = loadOracle(site);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return oracle.raw.checks.botAccessControl.webBotAuth as any;
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
  const result = await checkWebBotAuth(ctx);
  return { result, oracle: check, calls: stub.calls };
}

describe("checkWebBotAuth — oracle fixtures", () => {
  for (const site of ALL_SITES) {
    it(`matches the ${site} oracle`, async () => {
      const { result, oracle } = await runAgainstOracle(site);

      expect(() => CheckResultSchema.parse(result)).not.toThrow();

      expect(result.status).toBe(oracle.status);
      expect(result.message).toBe(oracle.message);
      expect(result.evidence).toHaveLength(oracle.evidence.length);

      for (let i = 0; i < oracle.evidence.length; i++) {
        const want = oracle.evidence[i];
        const got = result.evidence[i]!;
        expect(got.action, `evidence[${i}].action`).toBe(want.action);
        expect(got.label, `evidence[${i}].label`).toBe(want.label);
        // Oracle may omit the `finding` field on neutral fetch steps
        // (shopify fixture); our implementation always emits one. Only
        // assert parity when the oracle recorded a finding.
        if (want.finding !== undefined) {
          expect(got.finding.outcome, `evidence[${i}].finding.outcome`).toBe(
            want.finding.outcome,
          );
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("checkWebBotAuth — edge cases", () => {
  it("passes when a valid JWKS with non-empty keys[] is returned", async () => {
    const jwks = {
      keys: [
        {
          kty: "OKP",
          crv: "Ed25519",
          x: "abc",
          use: "sig",
          alg: "EdDSA",
          kid: "k1",
        },
      ],
    };
    const { fetchImpl } = makeFetchStub({
      "https://example.com/.well-known/http-message-signatures-directory": {
        status: 200,
        headers: { "content-type": "application/jwk-set+json" },
        body: JSON.stringify(jwks),
      },
    });
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkWebBotAuth(ctx);
    expect(result.status).toBe("pass");
    // Terminal step is a conclude with positive outcome.
    const last = result.evidence[result.evidence.length - 1]!;
    expect(last.action).toBe("conclude");
    expect(last.finding.outcome).toBe("positive");
  });

  it("stays neutral when the directory is missing (404)", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://example.com/.well-known/http-message-signatures-directory": {
        status: 404,
        headers: { "content-type": "text/html" },
      },
    });
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkWebBotAuth(ctx);
    expect(result.status).toBe("neutral");
  });

  it("stays neutral on transport errors", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("ENOTFOUND");
    };
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkWebBotAuth(ctx);
    expect(result.status).toBe("neutral");
  });

  it("stays neutral when the body is not valid JSON (informational)", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://example.com/.well-known/http-message-signatures-directory": {
        status: 200,
        headers: { "content-type": "application/json" },
        body: "<html>oops</html>",
      },
    });
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkWebBotAuth(ctx);
    expect(result.status).toBe("neutral");
  });
});
