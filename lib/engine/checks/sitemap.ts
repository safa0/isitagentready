/**
 * Discoverability check: `sitemap`.
 *
 * Specification
 * -------------
 * - Read /robots.txt (via memoised ctx.getRobotsTxt) and parse all `Sitemap:`
 *   directives. Emit a `parse` step summarising the count when robots.txt is
 *   reachable and declares at least one sitemap.
 * - Fetch each declared sitemap URL; accept the first 200 whose body parses
 *   as a `<urlset>` or `<sitemapindex>` XML document. The oracle records a
 *   fetch step for every URL it probed (even after finding a valid one), so
 *   we replay that behaviour.
 * - If no sitemap was declared (or robots.txt is missing), fall back to four
 *   well-known paths in order: /sitemap-index.xml, /sitemap.xml.gz,
 *   /sitemap_index.xml, /sitemap.xml.
 * - Pass: at least one sitemap URL responded 200 with a parsable XML root.
 */

import { XMLParser } from "fast-xml-parser";

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
const PARSE_DIRECTIVES_LABEL = "Extract Sitemap directives from robots.txt";

const PASS_MESSAGE = "sitemap.xml exists with valid structure";
const FAIL_NOT_FOUND_MESSAGE = "sitemap.xml not found";

const DEFAULT_SITEMAP_PATHS = [
  "/sitemap-index.xml",
  "/sitemap.xml.gz",
  "/sitemap_index.xml",
  "/sitemap.xml",
] as const;

/** Matches a Sitemap: directive (case-insensitive). */
const SITEMAP_DIRECTIVE_RE = /^\s*sitemap\s*:\s*(\S+)\s*$/gim;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  allowBooleanAttributes: true,
});

type SitemapKind = "urlset" | "sitemapindex";

function parseSitemapBody(body: string | undefined): SitemapKind | undefined {
  if (body === undefined || body.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const root = parsed as Record<string, unknown>;
  if ("urlset" in root) return "urlset";
  if ("sitemapindex" in root) return "sitemapindex";
  return undefined;
}

function extractSitemapUrls(body: string | undefined): string[] {
  if (body === undefined || body.length === 0) return [];
  const urls: string[] = [];
  const re = new RegExp(SITEMAP_DIRECTIVE_RE.source, SITEMAP_DIRECTIVE_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const value = match[1];
    if (value !== undefined && value.length > 0) urls.push(value);
  }
  return urls;
}

/**
 * Render a site-relative or absolute sitemap URL into a concise label.
 * Falls back to the raw string when parsing fails (e.g. a malformed Sitemap
 * directive pulled from robots.txt).
 */
function labelFor(urlStr: string, origin: string): string {
  try {
    const u = new URL(urlStr, origin);
    return `GET ${u.pathname}${u.search}`;
  } catch {
    return `GET ${urlStr}`;
  }
}

/**
 * Resolve a candidate against the origin. Returns `undefined` when the value
 * is unparseable — callers record a negative evidence step for that candidate
 * and move on rather than throwing out of the whole check.
 */
function resolveCandidate(candidate: string, origin: string): string | undefined {
  try {
    return new URL(candidate, origin).toString();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function checkSitemap(ctx: ScanContext): Promise<CheckResult> {
  const started = Date.now();
  const evidence: EvidenceStep[] = [];

  // 1. Read robots.txt (best-effort) and extract declared Sitemap URLs.
  const robots = await ctx.getRobotsTxt();
  const declaredFromRobots =
    robots.response?.status === 200 ? extractSitemapUrls(robots.body) : [];

  if (declaredFromRobots.length > 0) {
    evidence.push(
      makeStep("parse", PARSE_DIRECTIVES_LABEL, {
        outcome: "positive",
        summary: `Found ${declaredFromRobots.length} Sitemap directive(s) in robots.txt`,
      }),
    );
  }

  const fromRobotsTxt = declaredFromRobots.length > 0;
  const candidates = fromRobotsTxt
    ? declaredFromRobots
    : [...DEFAULT_SITEMAP_PATHS];

  // 2. Probe every candidate, record a fetch step per attempt, remember the
  // first valid one for the details block.
  let firstValidUrl: string | undefined;
  let firstValidKind: SitemapKind | undefined;

  for (const candidate of candidates) {
    const resolved = resolveCandidate(candidate, ctx.origin);
    const label = labelFor(candidate, ctx.origin);
    if (resolved === undefined) {
      evidence.push(
        makeStep("fetch", label, {
          outcome: "negative",
          summary: `Could not parse sitemap URL ${candidate}`,
        }),
      );
      continue;
    }
    const outcome: FetchOutcome = await ctx.fetch(resolved);

    if (outcome.response === undefined) {
      evidence.push(
        fetchToStep(outcome, label, {
          outcome: "negative",
          summary: outcome.error
            ? `${resolved} failed: ${outcome.error}`
            : `${resolved} failed with no response`,
        }),
      );
      continue;
    }

    const status = outcome.response.status;
    if (status !== 200) {
      evidence.push(
        fetchToStep(outcome, label, {
          outcome: "negative",
          summary: `${resolved} returned ${status}`,
        }),
      );
      continue;
    }

    const kind = parseSitemapBody(outcome.body);
    if (kind !== undefined) {
      if (firstValidUrl === undefined) {
        firstValidUrl = resolved;
        firstValidKind = kind;
      }
      evidence.push(
        fetchToStep(outcome, label, {
          outcome: "positive",
          summary: `Found valid xml sitemap at ${resolved}`,
        }),
      );
      continue;
    }

    evidence.push(
      fetchToStep(outcome, label, {
        outcome: "negative",
        summary: `${resolved} returned 200 but body is not a valid XML sitemap`,
      }),
    );
  }

  // 3. Conclude.
  if (firstValidUrl !== undefined) {
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
        url: firstValidUrl,
        fromRobotsTxt,
        format: "xml",
        kind: firstValidKind,
      },
      evidence,
      durationMs: Date.now() - started,
    };
  }

  evidence.push(
    makeStep("conclude", CONCLUDE_LABEL, {
      outcome: "negative",
      summary: fromRobotsTxt
        ? "No declared sitemap resolved with a valid XML response"
        : "sitemap.xml not found at any expected location",
    }),
  );

  return {
    status: "fail",
    message: FAIL_NOT_FOUND_MESSAGE,
    evidence,
    durationMs: Date.now() - started,
  };
}
