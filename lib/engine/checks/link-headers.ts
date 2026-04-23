/**
 * Discoverability check: `linkHeaders`.
 *
 * Specification
 * -------------
 * - GET homepage (`/`) via the memoised ctx.getHomepage() probe.
 * - Inspect the `Link:` response header (RFC 8288). Parse every link value
 *   and match it against the registered agent-useful relations
 *   (FINDINGS §9, confirmed against RFC 9727 §3).
 * - Pass iff at least one agent-useful relation is present.
 *
 * Evidence timeline
 * -----------------
 * - Pass: fetch -> parse (RFC 8288) -> parse (match) -> conclude (4 steps).
 * - Fail (no Link header): fetch -> conclude.
 * - Transport error: fetch -> conclude (fetch step records the error).
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

const CONCLUDE_LABEL = "Conclusion";
const FETCH_LABEL = "GET /";
const PARSE_HEADER_LABEL = "Parse Link header (RFC 8288)";
const MATCH_RELATIONS_LABEL = "Match agent-useful relations";

const FAIL_NO_LINK_MESSAGE = "No Link headers found on homepage";
const FAIL_NO_AGENT_REL_MESSAGE =
  "No agent-useful Link relations found on homepage";

/**
 * Agent-useful Link relation set. Source of truth: FINDINGS §3/§9.
 * - RFC 8288 / IANA-registered: api-catalog, service-doc, service-desc,
 *   describedby.
 * - Proposed/common for agent discovery: llms.txt, llms-full.txt, markdown.
 */
const AGENT_RELATIONS: ReadonlySet<string> = new Set([
  "api-catalog",
  "service-doc",
  "service-desc",
  "describedby",
  "llms.txt",
  "llms-full.txt",
  "markdown",
]);

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

interface ParsedLink {
  readonly href: string;
  readonly rel: string;
}

/**
 * Parse an RFC 8288 Link header into individual entries.
 *
 * Simplified but adequate for our fixtures: splits on commas that sit between
 * link-values (i.e. commas outside angle brackets and quoted strings), then
 * extracts each URI reference and every rel attribute. A single entry may
 * declare multiple space-separated relation tokens; we emit one ParsedLink
 * per rel token so the details.relationsFound shape matches the oracle.
 */
function parseLinkHeader(raw: string): ParsedLink[] {
  const entries = splitTopLevel(raw);
  const out: ParsedLink[] = [];
  for (const entry of entries) {
    const link = parseSingleLink(entry.trim());
    if (link === undefined) continue;
    for (const rel of link.rels) {
      out.push({ href: link.href, rel });
    }
  }
  return out;
}

/** Split a header value on commas outside angle brackets and quoted strings. */
function splitTopLevel(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inQuotes = false;
  let buf = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === undefined) continue;
    if (inQuotes) {
      buf += ch;
      // Simple \" escape detection; does not handle \\" sequences. Not observed in fixtures.
      if (ch === '"' && raw[i - 1] !== "\\") inQuotes = false;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      buf += ch;
      continue;
    }
    if (ch === "<") depth++;
    else if (ch === ">") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      if (buf.trim().length > 0) out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim().length > 0) out.push(buf);
  return out;
}

function parseSingleLink(
  entry: string,
): { href: string; rels: string[] } | undefined {
  const uriMatch = /^<([^>]+)>/.exec(entry);
  if (uriMatch === null) return undefined;
  const href = uriMatch[1];
  if (href === undefined) return undefined;

  // First-wins per RFC 8288; duplicate rel attrs in the same entry are ignored.
  const relMatch = /;\s*rel\s*=\s*(?:"([^"]*)"|([^\s;,]+))/i.exec(entry);
  if (relMatch === null) return undefined;
  const relValue = (relMatch[1] ?? relMatch[2] ?? "").trim();
  if (relValue.length === 0) return undefined;
  const rels = relValue.split(/\s+/).filter((r) => r.length > 0);
  return { href, rels };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function checkLinkHeaders(ctx: ScanContext): Promise<CheckResult> {
  const started = Date.now();
  const outcome: FetchOutcome = await ctx.getHomepage();

  if (outcome.response === undefined) {
    const fetchStep = fetchToStep(outcome, FETCH_LABEL, {
      outcome: "negative",
      summary: outcome.error
        ? `Homepage request failed: ${outcome.error}`
        : "Homepage request failed with no response",
    });
    const conclude = makeStep("conclude", CONCLUDE_LABEL, {
      outcome: "negative",
      summary: FAIL_NO_LINK_MESSAGE,
    });
    return {
      status: "fail",
      message: FAIL_NO_LINK_MESSAGE,
      evidence: [fetchStep, conclude],
      durationMs: Date.now() - started,
    };
  }

  const linkHeader = outcome.response.headers["link"];

  if (linkHeader === undefined || linkHeader.length === 0) {
    const fetchStep = fetchToStep(outcome, FETCH_LABEL, {
      outcome: "negative",
      summary: "No Link header present in response",
    });
    const conclude = makeStep("conclude", CONCLUDE_LABEL, {
      outcome: "negative",
      summary: FAIL_NO_LINK_MESSAGE,
    });
    return {
      status: "fail",
      message: FAIL_NO_LINK_MESSAGE,
      evidence: [fetchStep, conclude],
      durationMs: Date.now() - started,
    };
  }

  const fetchStep = fetchToStep(outcome, FETCH_LABEL, {
    outcome: "positive",
    summary: "Homepage returned 200 with Link header",
  });

  const parsed = parseLinkHeader(linkHeader);
  const parseStep = makeStep("parse", PARSE_HEADER_LABEL, {
    outcome: "neutral",
    summary: `Parsed ${parsed.length} link(s) from header`,
  });

  const agentMatches = parsed.filter((p) => AGENT_RELATIONS.has(p.rel));
  const matchedRels = [...new Set(agentMatches.map((p) => p.rel))];
  const evidence: EvidenceStep[] = [fetchStep, parseStep];

  if (agentMatches.length === 0) {
    evidence.push(
      makeStep("parse", MATCH_RELATIONS_LABEL, {
        outcome: "negative",
        summary: "No agent-useful relations found among parsed links",
      }),
    );
    evidence.push(
      makeStep("conclude", CONCLUDE_LABEL, {
        outcome: "negative",
        summary: FAIL_NO_AGENT_REL_MESSAGE,
      }),
    );
    return {
      status: "fail",
      message: FAIL_NO_AGENT_REL_MESSAGE,
      details: {
        relationsFound: [],
        totalLinks: parsed.length,
      },
      evidence,
      durationMs: Date.now() - started,
    };
  }

  const summaryRels = matchedRels.join(", ");
  evidence.push(
    makeStep("parse", MATCH_RELATIONS_LABEL, {
      outcome: "positive",
      summary: `Found agent-useful relations: ${summaryRels}`,
    }),
  );
  evidence.push(
    makeStep("conclude", CONCLUDE_LABEL, {
      outcome: "positive",
      summary: `Found agent-useful Link relations: ${summaryRels}`,
    }),
  );

  return {
    status: "pass",
    message: `Found agent-useful Link relations: ${summaryRels}`,
    details: {
      relationsFound: agentMatches.map((p) => ({ rel: p.rel, href: p.href })),
      totalLinks: parsed.length,
    },
    evidence,
    durationMs: Date.now() - started,
  };
}
