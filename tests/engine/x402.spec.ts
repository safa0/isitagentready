/**
 * Failing specs for the `x402` commerce check.
 *
 * Reference: FINDINGS §3 + §9.
 * Oracle: research/raw/scan-{shopify,vercel,cf-dev,cf,example}.json
 *         → checks.commerce.x402
 *
 * Fetch plan (per FINDINGS §9):
 *   1. GET /                                   (homepage)
 *   2. GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=500
 *   3. GET /api
 *   4. GET /api/v1
 *
 * Pass iff any of (1, 3, 4) return status 402 with x402 requirements,
 * or the origin appears in the bazaar response.
 *
 * isCommerce gating: when the caller passes `isCommerce=false`, the check
 * transforms its final status to "neutral" and appends " (not a commerce
 * site)" to the message. The evidence timeline is preserved verbatim.
 */

import { describe, it, expect } from "vitest";

import { makeFetchStub } from "./_helpers/oracle";
import { createScanContext } from "@/lib/engine/context";
import { CheckResultSchema } from "@/lib/schema";
import { checkX402 } from "@/lib/engine/checks/x402";

const BAZAAR_URL =
  "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=500";

function nonMatchingBazaar(): string {
  return JSON.stringify({ data: new Array(500).fill({ origin: "https://other.example" }) });
}

describe("x402 — shopify oracle (isCommerce=true)", () => {
  it("fails with a 5-step evidence timeline when no 402 responses are seen", async () => {
    const origin = "https://www.shopify.com";
    const { fetchImpl } = makeFetchStub({
      [`${origin}/`]: {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: "",
      },
      [BAZAAR_URL]: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: nonMatchingBazaar(),
      },
      [`${origin}/api`]: {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8" },
      },
      [`${origin}/api/v1`]: {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8" },
      },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });

    const result = await checkX402(ctx, { isCommerce: true });

    expect(CheckResultSchema.safeParse(result).success).toBe(true);
    expect(result.status).toBe("fail");
    expect(result.message).toBe("x402 payment protocol not detected");
    expect(result.evidence).toHaveLength(5);
    expect(result.evidence.map((s) => s.action)).toEqual([
      "fetch",
      "fetch",
      "fetch",
      "fetch",
      "conclude",
    ]);
  });

  it("passes when the origin responds with 402 on /api", async () => {
    const origin = "https://pay.test";
    const { fetchImpl } = makeFetchStub({
      [`${origin}/`]: { status: 200, headers: { "content-type": "text/html" }, body: "" },
      [BAZAAR_URL]: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: nonMatchingBazaar(),
      },
      [`${origin}/api`]: {
        status: 402,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x402Version: 1, accepts: [] }),
      },
      [`${origin}/api/v1`]: { status: 404 },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });
    const result = await checkX402(ctx, { isCommerce: true });
    expect(result.status).toBe("pass");
  });

  it("passes when the origin appears in the bazaar discovery", async () => {
    const origin = "https://in-bazaar.test";
    const { fetchImpl } = makeFetchStub({
      [`${origin}/`]: { status: 200, headers: { "content-type": "text/html" }, body: "" },
      [BAZAAR_URL]: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          data: [{ origin: "https://in-bazaar.test", resource: "/api" }],
        }),
      },
      [`${origin}/api`]: { status: 404 },
      [`${origin}/api/v1`]: { status: 404 },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });
    const result = await checkX402(ctx, { isCommerce: true });
    expect(result.status).toBe("pass");
  });
});

describe("x402 — non-commerce gating", () => {
  it("returns neutral with suffix on a non-commerce site", async () => {
    const origin = "https://vercel.com";
    const { fetchImpl } = makeFetchStub({
      [`${origin}/`]: {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: "",
      },
      [BAZAAR_URL]: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: nonMatchingBazaar(),
      },
      [`${origin}/api`]: {
        status: 200,
        headers: { "content-type": "text/markdown; charset=utf-8" },
      },
      [`${origin}/api/v1`]: {
        status: 404,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });
    const result = await checkX402(ctx, { isCommerce: false });
    expect(result.status).toBe("neutral");
    expect(result.message).toBe(
      "x402 payment protocol not detected (not a commerce site)",
    );
    // Evidence length stays the same; inner conclude summary is unchanged.
    expect(result.evidence).toHaveLength(5);
    const conclude = result.evidence[result.evidence.length - 1]!;
    expect(conclude.finding.summary).toBe("x402 payment protocol not detected");
  });
});
