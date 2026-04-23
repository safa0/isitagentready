/**
 * Failing specs for the `a2aAgentCard` check.
 *
 * Oracle: `research/raw/scan-*.json` → `checks.discovery.a2aAgentCard`.
 * Reference: `research/FINDINGS.md` §3, §9.
 *
 * Per FINDINGS §9 and the task specification:
 *   - GET `/.well-known/agent-card.json` on the origin.
 *   - Pass iff the response is 200 and the body is valid JSON containing at
 *     least `{ name, version, skills: [...] }`.
 *   - Fail otherwise (404, transport error, invalid JSON, missing fields).
 *
 * NOTE: this check is off by default in the UI (user opt-in via enabledChecks)
 * but the check itself still runs in the engine. The opt-out behaviour lives
 * in the scoring layer, not here.
 */

import { describe, it, expect } from "vitest";

import {
  ALL_SITES,
  expectCheckMatchesOracle,
  loadOracle,
  makeFetchStub,
  type OracleSite,
} from "./_helpers/oracle";
import { createScanContext } from "@/lib/engine/context";
import { CheckResultSchema, type EvidenceStep } from "@/lib/schema";

// Not-yet-implemented check; import fails until impl ships the file.
import { checkA2aAgentCard } from "@/lib/engine/checks/a2a-agent-card";

// ---------------------------------------------------------------------------
// Oracle harness
// ---------------------------------------------------------------------------

async function runAgainstOracle(site: OracleSite) {
  const oracle = loadOracle(site);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cardOracle = oracle.raw.checks.discovery.a2aAgentCard as any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fetchStep = cardOracle.evidence.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (s: any) => s.action === "fetch",
  );
  if (fetchStep === undefined) {
    throw new Error(`fixture ${site}: no fetch step found`);
  }

  const routes: Record<string, Parameters<typeof makeFetchStub>[0][string]> =
    {};
  routes[fetchStep.request.url] = {
    status: fetchStep.response.status,
    statusText: fetchStep.response.statusText,
    headers: fetchStep.response.headers,
    body: "",
  };

  const { fetchImpl } = makeFetchStub(routes);
  const ctx = createScanContext({ url: oracle.origin, fetchImpl });
  const result = await checkA2aAgentCard(ctx);
  return { oracle: cardOracle, result };
}

// ---------------------------------------------------------------------------
// Oracle round-trip — all fixtures fail (none of them serve an agent card)
// ---------------------------------------------------------------------------

describe("a2aAgentCard", () => {
  it.each(ALL_SITES)(
    "%s: round-trips against the fixture oracle",
    async (site) => {
      const { oracle, result } = await runAgainstOracle(site);
      expect(CheckResultSchema.safeParse(result).success).toBe(true);
      expectCheckMatchesOracle(result, oracle);
    },
  );
});

// ---------------------------------------------------------------------------
// Edge cases / pass behaviour
// ---------------------------------------------------------------------------

describe("a2aAgentCard — edge cases", () => {
  it("passes when agent-card.json returns a valid card", async () => {
    const body = JSON.stringify({
      name: "Example Agent",
      version: "1.0.0",
      description: "Demo",
      skills: [{ id: "search", name: "Search", description: "Search content" }],
    });
    const { fetchImpl } = makeFetchStub({
      "https://ok.test/.well-known/agent-card.json": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body,
      },
    });
    const ctx = createScanContext({ url: "https://ok.test", fetchImpl });
    const result = await checkA2aAgentCard(ctx);
    expect(result.status).toBe("pass");
    expect(result.details).toMatchObject({
      name: "Example Agent",
      version: "1.0.0",
      skillCount: 1,
    });
    // Evidence: fetch → validate (JSON) → validate (shape) → conclude.
    expect(result.evidence.map((s: EvidenceStep) => s.action)).toEqual([
      "fetch",
      "validate",
      "validate",
      "conclude",
    ]);
  });

  it("fails when agent-card.json is 200 but not valid JSON", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://bad.test/.well-known/agent-card.json": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: "{ not json",
      },
    });
    const ctx = createScanContext({ url: "https://bad.test", fetchImpl });
    const result = await checkA2aAgentCard(ctx);
    expect(result.status).toBe("fail");
    expect(result.message).toMatch(/invalid json|not valid json/i);
  });

  it("fails when agent-card.json is valid JSON but missing required fields", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://partial.test/.well-known/agent-card.json": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "x" }), // no version, no skills
      },
    });
    const ctx = createScanContext({ url: "https://partial.test", fetchImpl });
    const result = await checkA2aAgentCard(ctx);
    expect(result.status).toBe("fail");
    expect(result.message).toMatch(/missing|invalid/i);
  });

  it("fails when agent-card.json has empty skills array", async () => {
    const body = JSON.stringify({
      name: "No Skills Agent",
      version: "1.0.0",
      skills: [],
    });
    const { fetchImpl } = makeFetchStub({
      "https://noskills.test/.well-known/agent-card.json": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body,
      },
    });
    const ctx = createScanContext({ url: "https://noskills.test", fetchImpl });
    const result = await checkA2aAgentCard(ctx);
    expect(result.status).toBe("fail");
  });

  it("fails (not throws) when the fetch errors at the transport level", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://broken.test/.well-known/agent-card.json": new Error("ECONNRESET"),
    });
    const ctx = createScanContext({ url: "https://broken.test", fetchImpl });
    const result = await checkA2aAgentCard(ctx);
    expect(result.status).toBe("fail");
    expect(CheckResultSchema.safeParse(result).success).toBe(true);
    const fetchStep = result.evidence.find((s) => s.action === "fetch")!;
    expect(fetchStep.response).toBeUndefined();
  });

  it("records the fallback fetch-error summary when the error has no message", async () => {
    const emptyErr = new Error("");
    const { fetchImpl } = makeFetchStub({
      "https://silent.test/.well-known/agent-card.json": emptyErr,
    });
    const ctx = createScanContext({ url: "https://silent.test", fetchImpl });
    const result = await checkA2aAgentCard(ctx);
    expect(result.status).toBe("fail");
  });

  it("passes validation when skills entries omit optional fields", async () => {
    // Per task spec, only top-level { name, version, skills: [...] } is
    // required — individual skill entries don't need strict validation.
    const body = JSON.stringify({
      name: "Minimal",
      version: "0.1",
      skills: [{ id: "a" }, { id: "b" }, { id: "c" }],
    });
    const { fetchImpl } = makeFetchStub({
      "https://min.test/.well-known/agent-card.json": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body,
      },
    });
    const ctx = createScanContext({ url: "https://min.test", fetchImpl });
    const result = await checkA2aAgentCard(ctx);
    expect(result.status).toBe("pass");
    expect(result.details?.skillCount).toBe(3);
  });
});
