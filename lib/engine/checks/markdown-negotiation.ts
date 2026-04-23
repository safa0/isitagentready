/**
 * Check: markdownNegotiation (category: contentAccessibility).
 *
 * Fetches the homepage with `Accept: text/markdown` and verifies the response
 * returns Markdown. This mirrors the real Cloudflare scanner's behaviour as
 * recorded in `research/raw/*.json` — one fetch step, one conclusion step.
 *
 * Pass criterion: response `Content-Type` header starts with `text/markdown`.
 */

import {
  fetchToStep,
  makeStep,
  type ScanContext,
} from "@/lib/engine/context";
import type { CheckResult, EvidenceStep } from "@/lib/schema";

const ACCEPT_HEADER = "text/markdown";
const FETCH_LABEL = "GET homepage (Accept: text/markdown)";
const CONCLUDE_LABEL = "Conclusion";
const PASS_MESSAGE = "Site supports Markdown for Agents";
const FAIL_MESSAGE = "Site does not support Markdown for Agents";

// Match `text/markdown` as a full media type token — either alone or
// followed by parameters (`; charset=utf-8`). Prevents false matches like
// `text/markdown-foo` which a naive startsWith() would accept.
const MARKDOWN_CONTENT_TYPE_RE = /^text\/markdown(\s*;|\s*$)/i;

function isMarkdownContentType(contentType: string): boolean {
  return MARKDOWN_CONTENT_TYPE_RE.test(contentType.trim());
}

export async function checkMarkdownNegotiation(
  ctx: ScanContext,
): Promise<CheckResult> {
  const started = Date.now();
  const outcome = await ctx.fetch("/", {
    headers: { Accept: ACCEPT_HEADER },
  });

  const evidence: EvidenceStep[] = [];

  // Transport error: emit fetch step without response + fail conclusion.
  if (outcome.response === undefined) {
    const errorSummary = outcome.error ?? "Request failed";
    evidence.push(
      fetchToStep(outcome, FETCH_LABEL, {
        outcome: "negative",
        summary: errorSummary,
      }),
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

  const contentType = outcome.response.headers["content-type"] ?? "";
  const isMarkdown = isMarkdownContentType(contentType);

  const fetchFinding = isMarkdown
    ? {
        outcome: "positive" as const,
        summary: `Response content-type is ${contentType} -- site supports markdown negotiation`,
      }
    : {
        outcome: "negative" as const,
        summary: `Response content-type is ${contentType || "(none)"}, not text/markdown -- site does not support markdown content negotiation`,
      };

  evidence.push(fetchToStep(outcome, FETCH_LABEL, fetchFinding));
  evidence.push(
    makeStep("conclude", CONCLUDE_LABEL, {
      outcome: isMarkdown ? "positive" : "negative",
      summary: isMarkdown ? PASS_MESSAGE : FAIL_MESSAGE,
    }),
  );

  return {
    status: isMarkdown ? "pass" : "fail",
    message: isMarkdown ? PASS_MESSAGE : FAIL_MESSAGE,
    details: { contentType: contentType || "(none)" },
    evidence,
    durationMs: Date.now() - started,
  };
}
