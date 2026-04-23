"use client";

import { useEffect, useState } from "react";
import type { CheckId, CheckResult, CheckStatus } from "@/lib/schema";
import { PROMPTS } from "@/lib/engine/prompts";
import { CopyPromptButton } from "@/components/CopyPromptButton";
import { EvidenceTimeline } from "@/components/EvidenceTimeline";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * One check result as a collapsible row.
 *
 * Collapsed: status icon + human-readable check name + short message.
 * Expanded: two-tab panel (Overview | Audit details).
 * - Failing checks default to Overview (remediation copy first).
 * - Passing / neutral checks default to Audit (evidence-first).
 */

interface CheckRowProps {
  readonly checkId: CheckId;
  readonly check: CheckResult;
}

type TabKey = "overview" | "audit";

const CHECK_LABEL: Readonly<Record<CheckId, string>> = {
  robotsTxt: "robots.txt",
  sitemap: "sitemap.xml",
  linkHeaders: "Link headers",
  markdownNegotiation: "Markdown negotiation",
  robotsTxtAiRules: "robots.txt AI rules",
  contentSignals: "Content Signals",
  webBotAuth: "Web Bot Auth",
  apiCatalog: "API Catalog",
  oauthDiscovery: "OAuth discovery",
  oauthProtectedResource: "OAuth Protected Resource",
  mcpServerCard: "MCP Server Card",
  a2aAgentCard: "A2A Agent Card",
  agentSkills: "Agent Skills",
  webMcp: "WebMCP",
  x402: "x402",
  mpp: "MPP",
  ucp: "UCP",
  acp: "ACP",
  ap2: "AP2",
};

function StatusIcon({ status }: { readonly status: CheckStatus }): React.JSX.Element {
  if (status === "pass") {
    return (
      <span
        data-testid="status-icon-pass"
        aria-label="Pass"
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-green-500/15 text-green-600 dark:text-green-400"
      >
        <span aria-hidden="true">✓</span>
      </span>
    );
  }
  if (status === "fail") {
    return (
      <span
        data-testid="status-icon-fail"
        aria-label="Fail"
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-red-500/15 text-red-600 dark:text-red-400"
      >
        <span aria-hidden="true">✗</span>
      </span>
    );
  }
  return (
    <span
      data-testid="status-icon-neutral"
      aria-label="Not applicable"
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
    >
      <span aria-hidden="true">○</span>
    </span>
  );
}

function defaultTab(status: CheckStatus): TabKey {
  if (status === "fail") return "overview";
  return "audit";
}

export function CheckRow({ checkId, check }: CheckRowProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<TabKey>(defaultTab(check.status));

  useEffect(() => {
    setTab(defaultTab(check.status));
  }, [check.status]);

  const prompt = PROMPTS[checkId];
  const label = CHECK_LABEL[checkId];
  const showTabs = check.status === "fail";

  const toggle = (): void => setExpanded((v) => !v);

  return (
    <article
      data-slot="check-row"
      data-check-id={checkId}
      data-status={check.status}
      className="rounded-lg border border-border bg-card"
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        className={cn(
          "flex w-full items-start gap-3 px-4 py-3 text-left",
          "hover:bg-muted/40",
        )}
      >
        <StatusIcon status={check.status} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium tracking-tight text-foreground">
            {label}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {check.message}
          </span>
        </span>
      </button>

      {expanded ? (
        <div className="border-t border-border px-4 py-3">
          {showTabs ? (
            <>
              <div
                role="group"
                aria-label="Check detail tabs"
                className="mb-3 inline-flex gap-1 rounded-md bg-muted p-1"
              >
                <button
                  type="button"
                  data-testid="check-tab-overview"
                  aria-pressed={tab === "overview"}
                  onClick={() => setTab("overview")}
                  className={cn(
                    "rounded px-2 py-1 text-xs font-medium",
                    tab === "overview"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  Overview
                </button>
                <button
                  type="button"
                  data-testid="check-tab-audit"
                  aria-pressed={tab === "audit"}
                  onClick={() => setTab("audit")}
                  className={cn(
                    "rounded px-2 py-1 text-xs font-medium",
                    tab === "audit"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  Audit details
                </button>
              </div>

              {tab === "overview" ? (
                <div
                  data-testid="check-panel-overview"
                  className="flex flex-col gap-3 text-sm"
                >
                  <div>
                    <h4 className="text-sm font-semibold tracking-tight">
                      {label}
                    </h4>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {check.message}
                    </p>
                  </div>
                  <div>
                    <h5 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      How to implement
                    </h5>
                    <p className="mt-1 text-sm leading-relaxed">
                      {prompt.description}
                    </p>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                      {prompt.shortPrompt}
                    </p>
                  </div>
                  {prompt.specUrls.length > 0 ? (
                    <div>
                      <h5 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Resources
                      </h5>
                      <ul className="mt-1 flex flex-col gap-1 text-sm">
                        {prompt.specUrls.map((url: string) => (
                          <li key={url}>
                            <a
                              href={url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-orange-700 underline underline-offset-2 hover:opacity-80 dark:text-orange-400"
                            >
                              {url}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    <CopyPromptButton checkId={checkId} />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setTab("audit")}
                    >
                      View audit details
                    </Button>
                  </div>
                </div>
              ) : (
                <div data-testid="check-panel-audit">
                  <EvidenceTimeline
                    evidence={check.evidence}
                    durationMs={check.durationMs}
                  />
                </div>
              )}
            </>
          ) : (
            <div data-testid="check-panel-audit">
              <EvidenceTimeline
                evidence={check.evidence}
                durationMs={check.durationMs}
              />
            </div>
          )}
        </div>
      ) : null}
    </article>
  );
}
