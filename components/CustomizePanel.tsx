"use client";

import { useState } from "react";
import type { CategoryId, CheckId, Profile } from "@/lib/schema";
import { ALL_CHECK_IDS, CHECK_CATEGORY } from "@/lib/engine/scoring";
import { cn } from "@/lib/utils";

/**
 * Collapsible "Customize scan" panel. Lets the user pick a profile preset
 * (all / content / apiApp) and toggle individual checks. Commerce checks
 * are hidden when the profile is "content".
 */

interface CustomizePanelProps {
  readonly profile: Profile;
  readonly onProfileChange: (profile: Profile) => void;
  readonly checks: Record<CheckId, boolean>;
  readonly onCheckChange: (next: Record<CheckId, boolean>) => void;
  readonly isCommerce: boolean;
}

const CATEGORY_LABEL: Readonly<Record<CategoryId, string>> = {
  discoverability: "Discoverability",
  contentAccessibility: "Content Accessibility",
  botAccessControl: "Bot Access Control",
  discovery: "API / Auth / MCP",
  commerce: "Commerce",
};

const CHECK_LABEL: Readonly<Record<CheckId, string>> = {
  robotsTxt: "robots.txt",
  sitemap: "Sitemap",
  linkHeaders: "Link headers",
  markdownNegotiation: "Markdown negotiation",
  robotsTxtAiRules: "AI bot rules",
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

const CATEGORY_ORDER: readonly CategoryId[] = [
  "discoverability",
  "contentAccessibility",
  "botAccessControl",
  "discovery",
  "commerce",
];

const PROFILE_OPTIONS: readonly { id: Profile; label: string }[] = [
  { id: "all", label: "All Checks" },
  { id: "content", label: "Content Site" },
  { id: "apiApp", label: "API / Application" },
];

function groupChecks(): Readonly<Record<CategoryId, readonly CheckId[]>> {
  const out: Record<CategoryId, CheckId[]> = {
    discoverability: [],
    contentAccessibility: [],
    botAccessControl: [],
    discovery: [],
    commerce: [],
  };
  for (const id of ALL_CHECK_IDS) {
    out[CHECK_CATEGORY[id]].push(id);
  }
  return out;
}

const GROUPED_CHECKS = groupChecks();

export function CustomizePanel({
  profile,
  onProfileChange,
  checks,
  onCheckChange,
  isCommerce,
}: CustomizePanelProps): React.JSX.Element {
  const [open, setOpen] = useState(false);

  const toggleCheck = (id: CheckId): void => {
    const next = { ...checks, [id]: !checks[id] };
    onCheckChange(next);
  };

  const visibleCategories = CATEGORY_ORDER.filter((cat) => {
    if (cat === "commerce" && profile === "content") return false;
    return true;
  });

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="customize-panel-content"
        className={cn(
          "inline-flex items-center gap-2 rounded-md px-2 py-1 text-sm font-medium",
          open ? "text-[#F6821F]" : "text-foreground/80 hover:text-foreground",
        )}
      >
        <span aria-hidden="true" className="inline-block size-4">
          {/* Gear-ish mark, hand-drawn to avoid importing an icon for one button */}
          <svg viewBox="0 0 16 16" fill="none" className="size-full">
            <circle
              cx="8"
              cy="8"
              r="3"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path
              d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M3 13l1.5-1.5M11.5 4.5L13 3"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </span>
        <span>Customize scan</span>
        <span aria-hidden="true" className="text-xs">
          {open ? "▴" : "▾"}
        </span>
      </button>

      {open ? (
        <div
          id="customize-panel-content"
          className={cn(
            "mt-3 rounded-2xl border border-[#F6821F]/30 bg-[#FDF6EE] p-6",
            "dark:border-border dark:bg-card",
          )}
        >
          <fieldset>
            <legend className="mb-3 text-xs font-semibold uppercase tracking-wider text-foreground/70">
              Site type
            </legend>
            <div
              role="radiogroup"
              aria-label="Site type"
              className="flex flex-wrap gap-2"
            >
              {PROFILE_OPTIONS.map((opt) => {
                const active = profile === opt.id;
                return (
                  <label
                    key={opt.id}
                    className={cn(
                      "cursor-pointer rounded-full border px-4 py-1.5 text-sm font-medium transition",
                      active
                        ? "border-[#F6821F] bg-[#F6821F] text-white"
                        : "border-border bg-background text-foreground hover:border-[#F6821F]/50",
                    )}
                  >
                    <input
                      type="radio"
                      name="profile"
                      value={opt.id}
                      checked={active}
                      onChange={() => onProfileChange(opt.id)}
                      className="sr-only"
                    />
                    {opt.label}
                  </label>
                );
              })}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Customize which checks to run
            </p>
          </fieldset>

          <div className="mt-4 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {visibleCategories.map((cat) => {
              const ids = GROUPED_CHECKS[cat];
              if (ids.length === 0) return null;
              return (
                <fieldset key={cat} className="flex flex-col gap-2">
                  <legend className="text-xs font-semibold uppercase tracking-wider text-foreground/70">
                    {CATEGORY_LABEL[cat]}
                  </legend>
                  {ids.map((id) => {
                    const checked = checks[id] === true;
                    const commerceButNotCommerce =
                      cat === "commerce" && !isCommerce;
                    return (
                      <label
                        key={id}
                        className={cn(
                          "flex cursor-pointer items-center gap-2 text-sm",
                          commerceButNotCommerce && "opacity-60",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleCheck(id)}
                          className={cn(
                            "size-4 shrink-0 rounded accent-[#F6821F]",
                          )}
                        />
                        <span>{CHECK_LABEL[id]}</span>
                      </label>
                    );
                  })}
                </fieldset>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
