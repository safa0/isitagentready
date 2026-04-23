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

import { ALL_SITES, loadOracle, makeFetchStub } from "./_helpers/oracle";
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

describe("mpp — additional coverage", () => {
  it("passes when x-payment-info is nested inside an array", async () => {
    const origin = "https://arr.test";
    const body = JSON.stringify({
      openapi: "3.0.0",
      servers: [{ url: "https://arr.test", "x-payment-info": {} }],
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

  it("passes when x-payment-info is nested inside an operation", async () => {
    const origin = "https://nested.test";
    const body = JSON.stringify({
      openapi: "3.0.0",
      paths: {
        "/pay": {
          post: {
            "x-payment-info": { amount: 100 },
          },
        },
      },
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

  it("fails on a valid OpenAPI doc that has no x-payment-info", async () => {
    const origin = "https://plain.test";
    const body = JSON.stringify({ openapi: "3.0.0", paths: {} });
    const { fetchImpl } = makeFetchStub({
      [`${origin}/openapi.json`]: {
        status: 200,
        headers: { "content-type": "application/json" },
        body,
      },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });
    const result = await checkMpp(ctx, { isCommerce: true });
    expect(result.status).toBe("fail");
  });

  it("fails when openapi.json returns 200 with a non-JSON body", async () => {
    const origin = "https://nonjson.test";
    const { fetchImpl } = makeFetchStub({
      [`${origin}/openapi.json`]: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: "not json",
      },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });
    const result = await checkMpp(ctx, { isCommerce: true });
    expect(result.status).toBe("fail");
  });

  it("fails on a 500 response", async () => {
    const origin = "https://svr.test";
    const { fetchImpl } = makeFetchStub({
      [`${origin}/openapi.json`]: {
        status: 500,
        headers: { "content-type": "text/plain" },
      },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });
    const result = await checkMpp(ctx, { isCommerce: true });
    expect(result.status).toBe("fail");
  });
});

// These tests assert that the check's gating behaviour (status + message)
// is consistent across all oracle origins when the probe responses are
// stubbed to the negative baseline. They do NOT replay the full evidence
// timeline structurally — that is deferred pending real pass-case
// fixtures, after which we'd switch to `expectCheckMatchesOracle`.
describe("mpp — gating across origins", () => {
  it.each(ALL_SITES)(
    "matches the oracle status + message for %s",
    async (site) => {
      const fixture = loadOracle(site);
      const oracle = fixture.raw.checks.commerce.mpp;
      const isCommerce = Boolean(fixture.raw.isCommerce);
      const { fetchImpl } = makeFetchStub({
        [`${fixture.origin}/openapi.json`]: {
          status: 404,
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      });
      const ctx = createScanContext({ url: fixture.origin, fetchImpl });
      const result = await checkMpp(ctx, { isCommerce });
      expect(result.status).toBe(oracle.status);
      expect(result.message).toBe(oracle.message);
    },
  );
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
