/**
 * Oracle-driven tests for checkMcpServerCard.
 *
 * Spec (FINDINGS §3 / §9):
 *   Probes (in some order):
 *     GET /.well-known/mcp/server-card.json
 *     GET /.well-known/mcp/server-cards.json
 *     GET /.well-known/mcp.json
 *   Pass: Any 200 JSON that includes `serverInfo`/`name`/`version`/`endpoint`
 *         fields identifying an MCP server.
 *
 * Oracle observations across 5 fixtures (all 5 fail):
 *   - 4 evidence steps: 3 fetches + conclude.
 *   - Emission order varies per fixture (captures live resolution order). Our
 *     implementation now emits evidence in fixed DISPATCH order (CANDIDATES
 *     index), so we compare by label (order-independent for non-terminal
 *     steps) and still assert the conclusion is last.
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

import { checkMcpServerCard } from "@/lib/engine/checks/mcp-server-card";

// ---------------------------------------------------------------------------
// Oracle round-trip
// ---------------------------------------------------------------------------

function getOracleEntry(raw: unknown): OracleCheckLike {
  return (raw as { checks: { discovery: { mcpServerCard: OracleCheckLike } } })
    .checks.discovery.mcpServerCard;
}

const DISPATCH_ORDER = [
  "GET /.well-known/mcp/server-card.json",
  "GET /.well-known/mcp/server-cards.json",
  "GET /.well-known/mcp.json",
] as const;

const CANDIDATE_PATHS = [
  "/.well-known/mcp/server-card.json",
  "/.well-known/mcp/server-cards.json",
  "/.well-known/mcp.json",
] as const;

describe("checkMcpServerCard — oracle fixtures", () => {
  for (const site of ALL_SITES) {
    it(`matches the ${site} oracle`, async () => {
      const { result, oracle, origin, calls } = await runCheckAgainstOracle({
        site,
        getOracleEntry,
        runCheck: checkMcpServerCard,
      });

      expect(() => CheckResultSchema.parse(result)).not.toThrow();
      expectCheckMatchesOracle(result, oracle, { evidenceOrder: "by-label" });

      // Every candidate path must be probed.
      for (const path of CANDIDATE_PATHS) {
        expect(calls).toEqual(expect.arrayContaining([`${origin}${path}`]));
      }

      // Dispatch order is deterministic.
      for (let i = 0; i < DISPATCH_ORDER.length; i++) {
        expect(result.evidence[i]!.label).toBe(DISPATCH_ORDER[i]);
      }
      expect(result.evidence[result.evidence.length - 1]!.action).toBe(
        "conclude",
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

const JSON_HEADERS = { "content-type": "application/json" };

describe("checkMcpServerCard — edge cases", () => {
  it("passes when server-card.json contains name + version + endpoint", async () => {
    const card = {
      name: "example-mcp",
      version: "1.0.0",
      endpoint: "https://example.com/mcp",
    };
    const { fetchImpl } = makeFetchStub({
      "https://example.com/.well-known/mcp/server-card.json": {
        status: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify(card),
      },
      "https://example.com/.well-known/mcp/server-cards.json": {
        status: 404,
        headers: {},
      },
      "https://example.com/.well-known/mcp.json": {
        status: 404,
        headers: {},
      },
    });
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkMcpServerCard(ctx);
    expect(result.status).toBe("pass");
  });

  it("fails when all candidates return 404", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://example.com/.well-known/mcp/server-card.json": {
        status: 404,
        headers: {},
      },
      "https://example.com/.well-known/mcp/server-cards.json": {
        status: 404,
        headers: {},
      },
      "https://example.com/.well-known/mcp.json": {
        status: 404,
        headers: {},
      },
    });
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkMcpServerCard(ctx);
    expect(result.status).toBe("fail");
  });

  it("fails when 200 JSON returned but required fields missing", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://example.com/.well-known/mcp/server-card.json": {
        status: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({ foo: "bar" }),
      },
      "https://example.com/.well-known/mcp/server-cards.json": {
        status: 404,
        headers: {},
      },
      "https://example.com/.well-known/mcp.json": {
        status: 404,
        headers: {},
      },
    });
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkMcpServerCard(ctx);
    expect(result.status).toBe("fail");
  });

  it("fails gracefully on transport errors", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("ENOTFOUND");
    };
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkMcpServerCard(ctx);
    expect(result.status).toBe("fail");
  });

  it("accepts alternative {serverInfo:{name,version}, endpoint} shape", async () => {
    const card = {
      serverInfo: { name: "my-mcp", version: "2.0.0" },
      endpoint: "https://example.com/mcp",
    };
    const { fetchImpl } = makeFetchStub({
      "https://example.com/.well-known/mcp/server-card.json": {
        status: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify(card),
      },
      "https://example.com/.well-known/mcp/server-cards.json": {
        status: 404,
        headers: {},
      },
      "https://example.com/.well-known/mcp.json": {
        status: 404,
        headers: {},
      },
    });
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkMcpServerCard(ctx);
    expect(result.status).toBe("pass");
    expect(result.details?.name).toBe("my-mcp");
    expect(result.details?.version).toBe("2.0.0");
  });

  it("fails when 200 returns invalid JSON", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://example.com/.well-known/mcp/server-card.json": {
        status: 200,
        headers: JSON_HEADERS,
        body: "<not json>",
      },
      "https://example.com/.well-known/mcp/server-cards.json": {
        status: 404,
        headers: {},
      },
      "https://example.com/.well-known/mcp.json": {
        status: 404,
        headers: {},
      },
    });
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkMcpServerCard(ctx);
    expect(result.status).toBe("fail");
  });

  it("preserves dispatch order regardless of resolution timing", async () => {
    // Delay server-card.json so server-cards.json and mcp.json resolve first.
    const fetchImpl: typeof fetch = async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (url.endsWith("/server-card.json")) {
        await new Promise((r) => setTimeout(r, 20));
      }
      return new Response("", { status: 404 });
    };
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkMcpServerCard(ctx);
    for (let i = 0; i < DISPATCH_ORDER.length; i++) {
      expect(result.evidence[i]!.label).toBe(DISPATCH_ORDER[i]);
    }
  });

  it("preserves dispatch order when the delayed endpoint is the one that passes", async () => {
    // Delay server-card.json AND make it the passing 200 JSON; the fast
    // endpoints both 404. Dispatch-order emission must still place the
    // server-card.json fetch first even though it resolves last.
    const card = {
      name: "late-mcp",
      version: "1.0.0",
      endpoint: "https://example.com/mcp",
    };
    const fetchImpl: typeof fetch = async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (url.endsWith("/server-card.json")) {
        await new Promise((r) => setTimeout(r, 20));
        return new Response(JSON.stringify(card), {
          status: 200,
          headers: JSON_HEADERS,
        });
      }
      return new Response("", { status: 404 });
    };
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkMcpServerCard(ctx);
    expect(result.status).toBe("pass");
    for (let i = 0; i < DISPATCH_ORDER.length; i++) {
      expect(result.evidence[i]!.label).toBe(DISPATCH_ORDER[i]);
    }
  });
});
