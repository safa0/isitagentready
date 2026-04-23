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
 *   - Emission order varies per fixture; tests only assert the set of labels.
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

import { checkMcpServerCard } from "@/lib/engine/checks/mcp-server-card";

// ---------------------------------------------------------------------------
// Oracle round-trip
// ---------------------------------------------------------------------------

function getOracle(site: OracleSite) {
  const oracle = loadOracle(site);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return oracle.raw.checks.discovery.mcpServerCard as any;
}

const CANDIDATE_PATHS = [
  "/.well-known/mcp/server-card.json",
  "/.well-known/mcp/server-cards.json",
  "/.well-known/mcp.json",
] as const;

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
  const result = await checkMcpServerCard(ctx);
  return { result, oracle: check, calls: stub.calls };
}

describe("checkMcpServerCard — oracle fixtures", () => {
  for (const site of ALL_SITES) {
    it(`matches the ${site} oracle`, async () => {
      const { result, oracle, calls } = await runAgainstOracle(site);

      expect(() => CheckResultSchema.parse(result)).not.toThrow();

      expect(result.status).toBe(oracle.status);
      expect(result.message).toBe(oracle.message);
      expect(result.evidence).toHaveLength(oracle.evidence.length);

      // Every candidate path must be probed.
      const origin = new URL(oracle.url).origin;
      for (const path of CANDIDATE_PATHS) {
        expect(calls).toEqual(expect.arrayContaining([`${origin}${path}`]));
      }

      // Terminal step is Conclusion.
      const last = result.evidence[result.evidence.length - 1]!;
      expect(last.action).toBe("conclude");
      expect(last.label).toBe("Conclusion");
      expect(last.finding.outcome).toBe(
        oracle.evidence[oracle.evidence.length - 1].finding.outcome,
      );

      // Label set (order-independent) matches oracle.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const oracleLabels = oracle.evidence.map((s: any) => s.label).sort();
      const actualLabels = result.evidence.map((s) => s.label).sort();
      expect(actualLabels).toEqual(oracleLabels);
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
});
