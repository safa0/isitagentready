/**
 * Discovery check: `mcpServerCard` (SEP-1649 / MCP PR #2127).
 *
 * Specification (FINDINGS §3 / §9)
 * --------------------------------
 * Probe three candidate paths concurrently:
 *   - `/.well-known/mcp/server-card.json` (primary)
 *   - `/.well-known/mcp/server-cards.json`
 *   - `/.well-known/mcp.json`
 *
 * Pass criterion: any candidate returns 200 JSON identifying an MCP server.
 * Two identifying shapes are accepted:
 *   1. `{ name, version, endpoint }` (server-card primary shape)
 *   2. `{ serverInfo: { name, version }, endpoint }` (alternative shape)
 *
 * Evidence timeline
 * -----------------
 * Three fetches (in concurrent resolution order) + conclusion. When a
 * candidate responds with a valid card, an additional `validate` step is
 * emitted before the conclusion.
 */

import type { CheckResult, EvidenceStep } from "@/lib/schema";
import {
  fetchToStep,
  makeStep,
  type FetchOutcome,
  type ScanContext,
} from "@/lib/engine/context";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

interface Candidate {
  readonly path: string;
  readonly label: string;
}

const CANDIDATES: readonly Candidate[] = [
  {
    path: "/.well-known/mcp/server-card.json",
    label: "GET /.well-known/mcp/server-card.json",
  },
  {
    path: "/.well-known/mcp/server-cards.json",
    label: "GET /.well-known/mcp/server-cards.json",
  },
  {
    path: "/.well-known/mcp.json",
    label: "GET /.well-known/mcp.json",
  },
];

const CONCLUDE_LABEL = "Conclusion";
const VALIDATE_LABEL = "Validate MCP server card";

const PASS_MESSAGE = "MCP Server Card found";
const FAIL_MESSAGE = "MCP Server Card not found";
const FAIL_CONCLUDE_SUMMARY = "MCP Server Card not found at any candidate path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tryParseJson(body: string | undefined): unknown | undefined {
  if (body === undefined || body.length === 0) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

interface ValidCard {
  readonly name: string;
  readonly version: string;
  readonly endpoint: string;
}

function validateServerCard(json: unknown): ValidCard | undefined {
  if (json === null || typeof json !== "object") return undefined;
  const obj = json as Record<string, unknown>;

  // Shape 1: { name, version, endpoint }
  if (
    typeof obj.name === "string" &&
    typeof obj.version === "string" &&
    typeof obj.endpoint === "string"
  ) {
    return {
      name: obj.name,
      version: obj.version,
      endpoint: obj.endpoint,
    };
  }

  // Shape 2: { serverInfo: { name, version }, endpoint }
  const info = obj.serverInfo;
  if (
    info !== null &&
    typeof info === "object" &&
    typeof (info as Record<string, unknown>).name === "string" &&
    typeof (info as Record<string, unknown>).version === "string" &&
    typeof obj.endpoint === "string"
  ) {
    const si = info as Record<string, unknown>;
    return {
      name: si.name as string,
      version: si.version as string,
      endpoint: obj.endpoint,
    };
  }

  return undefined;
}

interface ProbeResult {
  readonly candidate: Candidate;
  readonly outcome: FetchOutcome;
  readonly fetchFinding: { outcome: "positive" | "negative"; summary: string };
  readonly card?: ValidCard;
}

async function probe(
  ctx: ScanContext,
  candidate: Candidate,
): Promise<ProbeResult> {
  const outcome = await ctx.fetch(candidate.path);

  if (outcome.response === undefined) {
    return {
      candidate,
      outcome,
      fetchFinding: {
        outcome: "negative",
        summary: `${candidate.path} request failed: ${outcome.error ?? "no response"}`,
      },
    };
  }

  if (outcome.response.status !== 200) {
    return {
      candidate,
      outcome,
      fetchFinding: {
        outcome: "negative",
        summary: `${candidate.path} returned ${outcome.response.status}`,
      },
    };
  }

  const json = tryParseJson(outcome.body);
  const card = validateServerCard(json);
  if (card === undefined) {
    return {
      candidate,
      outcome,
      fetchFinding: {
        outcome: "negative",
        summary: `${candidate.path} returned 200 but did not match MCP server card schema`,
      },
    };
  }

  return {
    candidate,
    outcome,
    fetchFinding: {
      outcome: "positive",
      summary: `${candidate.path} returned a valid MCP server card`,
    },
    card,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function checkMcpServerCard(
  ctx: ScanContext,
): Promise<CheckResult> {
  const started = Date.now();

  const probes = CANDIDATES.map((c) => probe(ctx, c));
  const results: ProbeResult[] = [];
  await Promise.all(
    probes.map(async (p) => {
      results.push(await p);
    }),
  );

  const evidence: EvidenceStep[] = [];
  for (const r of results) {
    evidence.push(fetchToStep(r.outcome, r.candidate.label, r.fetchFinding));
  }

  const found = results.find((r) => r.card !== undefined);
  if (found?.card !== undefined) {
    const { card } = found;
    evidence.push(
      makeStep("validate", VALIDATE_LABEL, {
        outcome: "positive",
        summary: `Valid card: name="${card.name}" version="${card.version}"`,
      }),
    );
    evidence.push(
      makeStep("conclude", CONCLUDE_LABEL, {
        outcome: "positive",
        summary: PASS_MESSAGE,
      }),
    );
    return {
      status: "pass",
      message: PASS_MESSAGE,
      details: {
        source: found.candidate.path,
        name: card.name,
        version: card.version,
        endpoint: card.endpoint,
      },
      evidence,
      durationMs: Date.now() - started,
    };
  }

  evidence.push(
    makeStep("conclude", CONCLUDE_LABEL, {
      outcome: "negative",
      summary: FAIL_CONCLUDE_SUMMARY,
    }),
  );
  return {
    status: "fail",
    message: FAIL_MESSAGE,
    evidence,
    durationMs: Date.now() - started,
  };
}
