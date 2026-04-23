/**
 * Failing specs for the `mpp` commerce check (Machine Payment Protocol).
 *
 * Reference: FINDINGS §3 + §9.
 * Oracle: research/raw/scan-{shopify,vercel,...}.json → checks.commerce.mpp
 *
 * Fetch plan: GET /openapi.json. Pass iff 200 + JSON body containing an
 * `x-payment-info` key (anywhere — OpenAPI root extensions or inside
 * path-level operations).
 *
 * Non-JSON responses (HTML soft-404, 404) → fail.
 */

import { describe, it, expect } from "vitest";

import { makeFetchStub } from "./_helpers/oracle";
import { createScanContext } from "@/lib/engine/context";
import { CheckResultSchema } from "@/lib/schema";
import { checkMpp } from "@/lib/engine/checks/mpp";

describe("mpp — shopify oracle (isCommerce=true)", () => {
  it("fails with a 2-step timeline on a 404", async () => {
    const origin = "https://www.shopify.com";
    const { fetchImpl } = makeFetchStub({
      [`${origin}/openapi.json`]: {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8" },
      },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });

    const result = await checkMpp(ctx, { isCommerce: true });

    expect(CheckResultSchema.safeParse(result).success).toBe(true);
    expect(result.status).toBe("fail");
    expect(result.message).toBe("MPP payment discovery not detected");
    expect(result.evidence.map((s) => s.action)).toEqual(["fetch", "conclude"]);
  });

  it("passes when openapi.json declares x-payment-info", async () => {
    const origin = "https://mpp.test";
    const body = JSON.stringify({
      openapi: "3.0.0",
      "x-payment-info": { currency: "USD" },
      paths: {},
    });
    const { fetchImpl } = makeFetchStub({
      [`${origin}/openapi.json`]: {
        status: 200,
        headers: { "content-type": "application/json" },
        body,
      },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });
    const result = await checkMpp(ctx, { isCommerce: true });
    expect(result.status).toBe("pass");
  });

  it("fails when openapi.json returns HTML (soft-404)", async () => {
    const origin = "https://soft.test";
    const { fetchImpl } = makeFetchStub({
      [`${origin}/openapi.json`]: {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: "<html></html>",
      },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });
    const result = await checkMpp(ctx, { isCommerce: true });
    expect(result.status).toBe("fail");
  });

  it("fails on transport error", async () => {
    const origin = "https://broken.test";
    const { fetchImpl } = makeFetchStub({
      [`${origin}/openapi.json`]: new Error("ECONNRESET"),
    });
    const ctx = createScanContext({ url: origin, fetchImpl });
    const result = await checkMpp(ctx, { isCommerce: true });
    expect(result.status).toBe("fail");
  });
});

describe("mpp — non-commerce gating", () => {
  it("returns neutral with suffix on a non-commerce site", async () => {
    const origin = "https://vercel.com";
    const { fetchImpl } = makeFetchStub({
      [`${origin}/openapi.json`]: {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: "<html></html>",
      },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });
    const result = await checkMpp(ctx, { isCommerce: false });
    expect(result.status).toBe("neutral");
    expect(result.message).toBe(
      "MPP payment discovery not detected (not a commerce site)",
    );
  });
});
