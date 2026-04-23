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
  expectCheckMatchesOracle,
  makeFetchStub,
  runCheckAgainstOracle,
  type OracleCheckLike,
} from "./_helpers/oracle";
import { createScanContext } from "@/lib/engine/context";
import { CheckResultSchema } from "@/lib/schema";

import { checkWebBotAuth } from "@/lib/engine/checks/web-bot-auth";

// ---------------------------------------------------------------------------
// Oracle round-trip
// ---------------------------------------------------------------------------

function getOracleEntry(raw: unknown): OracleCheckLike {
  return (raw as { checks: { botAccessControl: { webBotAuth: OracleCheckLike } } })
    .checks.botAccessControl.webBotAuth;
}

describe("checkWebBotAuth — oracle fixtures", () => {
  for (const site of ALL_SITES) {
    it(`matches the ${site} oracle`, async () => {
      const { result, oracle } = await runCheckAgainstOracle({
        site,
        getOracleEntry,
        runCheck: checkWebBotAuth,
      });

      expect(() => CheckResultSchema.parse(result)).not.toThrow();
      expectCheckMatchesOracle(result, oracle);
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
