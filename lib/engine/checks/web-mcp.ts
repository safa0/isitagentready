/**
 * Discovery check: `webMcp`.
 *
 * Specification
 * -------------
 * Detect WebMCP tool registrations on the page. The reference scanner uses a
 * real Chromium instance to evaluate page JavaScript and observe
 * `navigator.modelContext.registerTool()` / `provideContext()` calls at
 * runtime. We run on Vercel Fluid Compute (Node), so we use a
 *
 *     Static fallback only; upgrade path is Vercel Sandbox for real Chromium eval.
 *
 * detector that:
 *   1. Fetches the homepage HTML via ctx.getHomepage().
 *   2. Extracts every inline `<script>...</script>` block and scans its body
 *      for `navigator.modelContext.{registerTool|provideContext}`.
 *   3. Extracts every `<script src="...">` URL, resolves it against the
 *      homepage origin, and -- ONLY for same-origin scripts (SSRF guard:
 *      `new URL(src, homepage).origin === homepage.origin`) -- fetches the
 *      script body and scans it for the same regex. Cross-origin scripts
 *      are skipped with an explicit evidence step.
 *   4. Caps the number of linked scripts probed at LINKED_SCRIPT_LIMIT to
 *      keep the probe budget bounded.
 *   5. Passes iff any inline or same-origin linked script contains a match.
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

const FETCH_HOMEPAGE_LABEL = "GET /";
const PARSE_INLINE_LABEL = "Scan inline <script> blocks";
const PARSE_LINKED_INDEX_LABEL = "Enumerate linked <script src> URLs";
const CONCLUDE_LABEL = "Conclusion";

const PASS_MESSAGE =
  "WebMCP tool registrations detected via static script analysis";
const FAIL_MESSAGE = "No WebMCP tools detected on page load";

/**
 * Matches `navigator.modelContext.registerTool(` or
 * `navigator.modelContext.provideContext(` anywhere in a script source.
 * The trailing `(` avoids matching a bare mention in prose or docstrings.
 */
const WEBMCP_API_REGEX =
  /navigator\s*\.\s*modelContext\s*\.\s*(registerTool|provideContext)\s*\(/;

/**
 * Match `<script ...>...</script>` non-greedily to capture inline bodies.
 *
 * NOTE: this mirrors browser HTML parser rules loosely — it cuts the body at
 * the first `</script` sequence and does NOT handle `>` characters embedded
 * inside quoted attribute values (e.g. `<script data-x="a>b">`). Real browsers
 * tokenise attributes properly; we accept the edge case because the WebMCP
 * API signature we match is unlikely to appear in such pathological markup.
 */
const INLINE_SCRIPT_REGEX = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

/** Match a `src="..."` or `src='...'` or bare `src=...` attribute. */
const SCRIPT_SRC_REGEX =
  /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i;

/** Cap on the number of same-origin linked scripts we probe per page. */
const LINKED_SCRIPT_LIMIT = 20;

// ---------------------------------------------------------------------------
// HTML parsing helpers
// ---------------------------------------------------------------------------

interface ScriptScan {
  readonly inlineBodies: string[];
  readonly srcUrls: string[];
}

/**
 * Extract inline script bodies and script src URLs from an HTML document.
 * A regex-based approach is sufficient for our static detection use case --
 * we are not building a full HTML parser; we tolerate malformed markup by
 * letting unmatched tags be ignored.
 */
function scanScripts(html: string): ScriptScan {
  const inlineBodies: string[] = [];
  const srcUrls: string[] = [];

  const re = new RegExp(INLINE_SCRIPT_REGEX.source, INLINE_SCRIPT_REGEX.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";
    const srcMatch = SCRIPT_SRC_REGEX.exec(attrs);
    if (srcMatch !== null) {
      const src = srcMatch[1] ?? srcMatch[2] ?? srcMatch[3];
      if (src !== undefined && src.length > 0) {
        srcUrls.push(src);
      }
    } else if (body.trim().length > 0) {
      inlineBodies.push(body);
    }
  }
  return { inlineBodies, srcUrls };
}

function matchWebMcpApi(source: string): string | undefined {
  const match = WEBMCP_API_REGEX.exec(source);
  return match?.[1];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function checkWebMcp(ctx: ScanContext): Promise<CheckResult> {
  const started = Date.now();
  const evidence: EvidenceStep[] = [];

  // 1. Fetch homepage.
  const homepage: FetchOutcome = await ctx.getHomepage();

  if (homepage.response === undefined) {
    evidence.push(
      fetchToStep(homepage, FETCH_HOMEPAGE_LABEL, {
        outcome: "negative",
        summary: homepage.error
          ? `Homepage request failed: ${homepage.error}`
          : "Homepage request failed with no response",
      }),
    );
    evidence.push(
      makeStep("conclude", CONCLUDE_LABEL, {
        outcome: "negative",
        summary: FAIL_MESSAGE,
      }),
    );
    return {
      status: "fail",
      message: FAIL_MESSAGE,
      evidence,
      durationMs: Date.now() - started,
    };
  }

  evidence.push(
    fetchToStep(homepage, FETCH_HOMEPAGE_LABEL, {
      outcome: "neutral",
      summary: `Fetched homepage (${homepage.response.status}) for WebMCP static analysis`,
    }),
  );

  const html = homepage.body ?? "";
  const { inlineBodies, srcUrls } = scanScripts(html);

  // 2. Scan inline scripts.
  let foundIn: string | undefined;
  let foundPattern: string | undefined;

  for (const body of inlineBodies) {
    const pattern = matchWebMcpApi(body);
    if (pattern !== undefined) {
      foundIn = "inline script";
      foundPattern = `navigator.modelContext.${pattern}`;
      break;
    }
  }

  evidence.push(
    makeStep("parse", PARSE_INLINE_LABEL, {
      outcome: foundIn !== undefined ? "positive" : "neutral",
      summary:
        foundIn !== undefined
          ? `Matched ${foundPattern} in inline script`
          : `Scanned ${inlineBodies.length} inline script block(s); no match`,
    }),
  );

  // 3. Scan linked scripts (same-origin only, with SSRF guard).
  if (foundIn === undefined && srcUrls.length > 0) {
    evidence.push(
      makeStep("parse", PARSE_LINKED_INDEX_LABEL, {
        outcome: "neutral",
        summary: `Found ${srcUrls.length} linked <script src> URL(s)`,
      }),
    );

    let probed = 0;
    for (const src of srcUrls) {
      if (probed >= LINKED_SCRIPT_LIMIT) break;

      let target: URL;
      try {
        target = new URL(src, ctx.url);
      } catch {
        evidence.push(
          makeStep("parse", `Resolve script URL ${src}`, {
            outcome: "negative",
            summary: `Could not parse script URL: ${src}`,
          }),
        );
        continue;
      }

      // SSRF guard: only fetch same-origin scripts.
      if (target.origin !== ctx.url.origin) {
        evidence.push(
          makeStep("parse", `Skip cross-origin script ${target.origin}`, {
            outcome: "neutral",
            summary: `Skipping cross-origin script: ${target.toString()}`,
          }),
        );
        continue;
      }

      probed++;
      const scriptOutcome = await ctx.fetch(target.toString());
      if (
        scriptOutcome.response === undefined ||
        scriptOutcome.response.status !== 200 ||
        scriptOutcome.body === undefined
      ) {
        evidence.push(
          fetchToStep(scriptOutcome, `GET ${target.pathname}`, {
            outcome: "negative",
            summary: scriptOutcome.response
              ? `Linked script returned ${scriptOutcome.response.status}`
              : `Linked script fetch failed: ${scriptOutcome.error ?? "unknown"}`,
          }),
        );
        continue;
      }

      const pattern = matchWebMcpApi(scriptOutcome.body);
      if (pattern !== undefined) {
        foundIn = target.toString();
        foundPattern = `navigator.modelContext.${pattern}`;
        evidence.push(
          fetchToStep(scriptOutcome, `GET ${target.pathname}`, {
            outcome: "positive",
            summary: `Matched ${foundPattern} in linked script`,
          }),
        );
        break;
      }

      evidence.push(
        fetchToStep(scriptOutcome, `GET ${target.pathname}`, {
          outcome: "neutral",
          summary: "No WebMCP API reference in linked script",
        }),
      );
    }
  }

  // 4. Conclude.
  if (foundIn === undefined) {
    evidence.push(
      makeStep("conclude", CONCLUDE_LABEL, {
        outcome: "negative",
        summary: FAIL_MESSAGE,
      }),
    );
    return {
      status: "fail",
      message: FAIL_MESSAGE,
      evidence,
      durationMs: Date.now() - started,
    };
  }

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
      foundIn,
      pattern: foundPattern,
      // Documented limitation so downstream consumers can surface caveats.
      // Static fallback only; upgrade path is Vercel Sandbox for real
      // Chromium eval.
      detectionMode: "static-fallback",
    },
    evidence,
    durationMs: Date.now() - started,
  };
}
