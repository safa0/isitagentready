/**
 * Failing specs for the `ucp` commerce check (Universal Commerce Protocol).
 *
 * Reference: FINDINGS §3 + §9.
 * Oracle: research/raw/scan-*.json → checks.commerce.ucp
 *
 * Fetch plan: GET /.well-known/ucp.
 * Pass iff 200 + JSON with `protocol_version`, `services`, `capabilities`,
 * and `endpoints` fields. Otherwise fail.
 */

import { describe, it, expect } from "vitest";

import { makeFetchStub } from "./_helpers/oracle";
import { createScanContext } from "@/lib/engine/context";
import { CheckResultSchema } from "@/lib/schema";
import { checkUcp } from "@/lib/engine/checks/ucp";

describe("ucp — shopify oracle (isCommerce=true)", () => {
  it("fails with a 2-step timeline on a 404", async () => {
    const origin = "https://www.shopify.com";
    const { fetchImpl } = makeFetchStub({
      [`${origin}/.well-known/ucp`]: {
        status: 404,
        headers: {
          "content-type": "text/plain;charset=UTF-8",
          "content-length": "9",
        },
      },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });

    const result = await checkUcp(ctx, { isCommerce: true });

    expect(CheckResultSchema.safeParse(result).success).toBe(true);
    expect(result.status).toBe("fail");
    expect(result.message).toBe("UCP profile not found");
    expect(result.evidence.map((s) => s.action)).toEqual(["fetch", "conclude"]);
  });

  it("passes with a valid UCP profile", async () => {
    const origin = "https://ucp.test";
    const body = JSON.stringify({
      protocol_version: "1.0",
      services: ["checkout"],
      capabilities: ["payments"],
      endpoints: { checkout: "/api/checkout" },
    });
    const { fetchImpl } = makeFetchStub({
      [`${origin}/.well-known/ucp`]: {
        status: 200,
        headers: { "content-type": "application/json" },
        body,
      },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });
    const result = await checkUcp(ctx, { isCommerce: true });
    expect(result.status).toBe("pass");
  });

  it("fails when the UCP JSON is missing required fields", async () => {
    const origin = "https://partial.test";
    const body = JSON.stringify({ protocol_version: "1.0" });
    const { fetchImpl } = makeFetchStub({
      [`${origin}/.well-known/ucp`]: {
        status: 200,
        headers: { "content-type": "application/json" },
        body,
      },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });
    const result = await checkUcp(ctx, { isCommerce: true });
    expect(result.status).toBe("fail");
  });

  it("fails on transport error", async () => {
    const origin = "https://broken.test";
    const { fetchImpl } = makeFetchStub({
      [`${origin}/.well-known/ucp`]: new Error("ECONNRESET"),
    });
    const ctx = createScanContext({ url: origin, fetchImpl });
    const result = await checkUcp(ctx, { isCommerce: true });
    expect(result.status).toBe("fail");
  });
});

describe("ucp — non-commerce gating", () => {
  it("returns neutral with suffix on a non-commerce site", async () => {
    const origin = "https://vercel.com";
    const { fetchImpl } = makeFetchStub({
      [`${origin}/.well-known/ucp`]: {
        status: 404,
        headers: { "content-type": "text/plain;charset=UTF-8" },
      },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });
    const result = await checkUcp(ctx, { isCommerce: false });
    expect(result.status).toBe("neutral");
    expect(result.message).toBe("UCP profile not found (not a commerce site)");
  });
});
