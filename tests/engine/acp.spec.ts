/**
 * Failing specs for the `acp` commerce check (Agentic Commerce Protocol).
 *
 * Reference: FINDINGS §3 + §9.
 * Oracle: research/raw/scan-*.json → checks.commerce.acp
 *
 * Fetch plan: GET /.well-known/acp.json.
 * Pass iff 200 + JSON body with:
 *   - protocol.name === "acp"
 *   - api_base_url present
 *   - transports[] non-empty
 *   - capabilities.services[] non-empty
 */

import { describe, it, expect } from "vitest";

import { ALL_SITES, loadOracle, makeFetchStub } from "./_helpers/oracle";
import { createScanContext } from "@/lib/engine/context";
import { CheckResultSchema } from "@/lib/schema";
import { checkAcp } from "@/lib/engine/checks/acp";

describe("acp — shopify oracle (isCommerce=true)", () => {
  it("fails with a 2-step timeline on a 404", async () => {
    const origin = "https://www.shopify.com";
    const { fetchImpl } = makeFetchStub({
      [`${origin}/.well-known/acp.json`]: {
        status: 404,
        headers: {
          "content-type": "text/plain;charset=UTF-8",
          "content-length": "9",
        },
      },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });

    const result = await checkAcp(ctx, { isCommerce: true });

    expect(CheckResultSchema.safeParse(result).success).toBe(true);
    expect(result.status).toBe("fail");
    expect(result.message).toBe("ACP discovery document not found");
    expect(result.evidence.map((s) => s.action)).toEqual(["fetch", "conclude"]);
  });

  it("passes with a valid ACP discovery document", async () => {
    const origin = "https://acp.test";
    const body = JSON.stringify({
      protocol: { name: "acp", version: "1.0" },
      api_base_url: "https://acp.test/api",
      transports: [{ kind: "https" }],
      capabilities: { services: ["catalog"] },
    });
    const { fetchImpl } = makeFetchStub({
      [`${origin}/.well-known/acp.json`]: {
        status: 200,
        headers: { "content-type": "application/json" },
        body,
      },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });
    const result = await checkAcp(ctx, { isCommerce: true });
    expect(result.status).toBe("pass");
  });

  it("fails when protocol.name is wrong", async () => {
    const origin = "https://wrong.test";
    const body = JSON.stringify({
      protocol: { name: "other" },
      api_base_url: "x",
      transports: [{}],
      capabilities: { services: ["x"] },
    });
    const { fetchImpl } = makeFetchStub({
      [`${origin}/.well-known/acp.json`]: {
        status: 200,
        headers: { "content-type": "application/json" },
        body,
      },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });
    const result = await checkAcp(ctx, { isCommerce: true });
    expect(result.status).toBe("fail");
  });

  it("fails when transports is empty", async () => {
    const origin = "https://empty.test";
    const body = JSON.stringify({
      protocol: { name: "acp" },
      api_base_url: "x",
      transports: [],
      capabilities: { services: ["x"] },
    });
    const { fetchImpl } = makeFetchStub({
      [`${origin}/.well-known/acp.json`]: {
        status: 200,
        headers: { "content-type": "application/json" },
        body,
      },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });
    const result = await checkAcp(ctx, { isCommerce: true });
    expect(result.status).toBe("fail");
  });

  it("fails on transport error", async () => {
    const origin = "https://broken.test";
    const { fetchImpl } = makeFetchStub({
      [`${origin}/.well-known/acp.json`]: new Error("ECONNRESET"),
    });
    const ctx = createScanContext({ url: origin, fetchImpl });
    const result = await checkAcp(ctx, { isCommerce: true });
    expect(result.status).toBe("fail");
  });
});

// These tests assert that the check's gating behaviour (status + message)
// is consistent across all oracle origins when the probe responses are
// stubbed to the negative baseline. They do NOT replay the full evidence
// timeline structurally — that is deferred pending real pass-case
// fixtures, after which we'd switch to `expectCheckMatchesOracle`.
describe("acp — gating across origins", () => {
  it.each(ALL_SITES)(
    "matches the oracle status + message for %s",
    async (site) => {
      const fixture = loadOracle(site);
      const oracle = fixture.raw.checks.commerce.acp;
      const isCommerce = Boolean(fixture.raw.isCommerce);
      const { fetchImpl } = makeFetchStub({
        [`${fixture.origin}/.well-known/acp.json`]: {
          status: 404,
          headers: { "content-type": "text/plain;charset=UTF-8" },
        },
      });
      const ctx = createScanContext({ url: fixture.origin, fetchImpl });
      const result = await checkAcp(ctx, { isCommerce });
      expect(result.status).toBe(oracle.status);
      expect(result.message).toBe(oracle.message);
    },
  );
});

describe("acp — non-commerce gating", () => {
  it("returns neutral with suffix on a non-commerce site", async () => {
    const origin = "https://vercel.com";
    const { fetchImpl } = makeFetchStub({
      [`${origin}/.well-known/acp.json`]: {
        status: 404,
        headers: { "content-type": "text/plain;charset=UTF-8" },
      },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });
    const result = await checkAcp(ctx, { isCommerce: false });
    expect(result.status).toBe("neutral");
    expect(result.message).toBe(
      "ACP discovery document not found (not a commerce site)",
    );
  });
});
