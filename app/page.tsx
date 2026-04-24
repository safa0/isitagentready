"use client";

import { useMemo, useState } from "react";
import { ScanForm } from "@/components/ScanForm";
import { CustomizePanel } from "@/components/CustomizePanel";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  ALL_CHECK_IDS,
  DEFAULT_ENABLED_CHECKS,
} from "@/lib/engine/scoring";
import type { CheckId, Profile } from "@/lib/schema";

function buildInitialChecks(): Record<CheckId, boolean> {
  const out = {} as Record<CheckId, boolean>;
  for (const id of ALL_CHECK_IDS) {
    out[id] = DEFAULT_ENABLED_CHECKS.includes(id);
  }
  return out;
}

export default function Home(): React.JSX.Element {
  const [profile, setProfile] = useState<Profile>("all");
  const [checks, setChecks] = useState<Record<CheckId, boolean>>(() =>
    buildInitialChecks(),
  );

  const enabledChecks = useMemo<readonly CheckId[]>(
    () => ALL_CHECK_IDS.filter((id) => checks[id] === true),
    [checks],
  );

  return (
    <div className="flex min-h-full flex-1 flex-col bg-background">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-6">
        <span className="inline-flex items-center gap-2 font-semibold tracking-tight">
          <span
            aria-hidden="true"
            className="inline-flex size-8 items-center justify-center rounded-lg bg-[#F6821F]/10 text-[#F6821F]"
          >
            <svg viewBox="0 0 24 24" fill="none" className="size-5">
              <path
                d="M4 14a5 5 0 015-5h1a6 6 0 0110.87 3.5A3.5 3.5 0 0119 19H7a3 3 0 01-3-3v-2z"
                fill="currentColor"
              />
            </svg>
          </span>
          <span className="text-sm text-foreground/80">Agent Ready</span>
        </span>
        <div className="flex items-center gap-2">
          <a
            href="https://github.com/safa0/isitagentready"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-full border border-[#F6821F]/60 px-4 py-1.5 text-sm font-medium text-[#F6821F] hover:bg-[#F6821F]/10"
          >
            Learn more about Agents
            <span aria-hidden="true">↗</span>
          </a>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center gap-8 px-6 pb-16 pt-8 sm:pt-16">
        <section className="flex flex-col items-center gap-4 text-center">
          <h1 className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
            Is Your Site Agent-Ready?
          </h1>
          <p className="max-w-xl text-base leading-relaxed text-foreground/80 sm:text-lg">
            Scan your website to see how ready it is for AI agents. We check
            multiple emerging standards — from robots.txt and{" "}
            <a
              className="text-[#F6821F] underline underline-offset-2"
              href="https://developers.cloudflare.com/agents/"
              target="_blank"
              rel="noreferrer"
            >
              Markdown negotiation
            </a>{" "}
            to{" "}
            <a
              className="text-[#F6821F] underline underline-offset-2"
              href="https://modelcontextprotocol.io/"
              target="_blank"
              rel="noreferrer"
            >
              MCP
            </a>
            , OAuth,{" "}
            <a
              className="text-[#F6821F] underline underline-offset-2"
              href="https://a2aprotocol.ai/"
              target="_blank"
              rel="noreferrer"
            >
              Agent Skills
            </a>{" "}
            and agentic commerce.
          </p>
        </section>

        <section className="flex w-full flex-col items-start gap-3">
          <ScanForm
            profile={profile}
            enabledChecks={
              enabledChecks.length === ALL_CHECK_IDS.length
                ? undefined
                : enabledChecks
            }
          />
          <CustomizePanel
            profile={profile}
            onProfileChange={setProfile}
            checks={checks}
            onCheckChange={setChecks}
            isCommerce={true}
          />
        </section>

        <section className="w-full">
          <Accordion className="flex flex-col gap-3">
            <AccordionItem
              value="what"
              className="rounded-2xl border border-border bg-card px-5"
            >
              <AccordionTrigger className="py-4 text-base">
                What do we check?
              </AccordionTrigger>
              <AccordionContent>
                <p>
                  We run 19 independent checks across five categories:
                  discoverability, content accessibility, bot access control,
                  API/auth/MCP discovery, and agentic commerce. Each check is a
                  lightweight probe against well-known URLs and response
                  headers. No authentication, no crawl — one pass per check.
                </p>
              </AccordionContent>
            </AccordionItem>
            <AccordionItem
              value="improve"
              className="rounded-2xl border border-border bg-card px-5"
            >
              <AccordionTrigger className="py-4 text-base">
                What&apos;s the easiest way to improve my score?
              </AccordionTrigger>
              <AccordionContent>
                <p>
                  Start with robots.txt and a sitemap — these unlock Level 1 on
                  their own. Then add explicit AI-bot rules and a Content
                  Signals policy to reach Level 2. The results page shows the
                  exact failing check and gives you a ready-to-paste prompt for
                  your coding agent.
                </p>
              </AccordionContent>
            </AccordionItem>
            <AccordionItem
              value="learn"
              className="rounded-2xl border border-border bg-card px-5"
            >
              <AccordionTrigger className="py-4 text-base">
                Where can I learn more?
              </AccordionTrigger>
              <AccordionContent>
                <p>
                  We track open standards across the ecosystem: the{" "}
                  <a
                    href="https://modelcontextprotocol.io/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Model Context Protocol
                  </a>
                  ,{" "}
                  <a
                    href="https://a2aprotocol.ai/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Agent-to-Agent
                  </a>
                  , OAuth 2.0 Protected Resource Metadata, and emerging agentic
                  commerce protocols (x402, MPP, UCP, ACP, AP2).
                </p>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </section>

        <p className="mt-4 max-w-2xl text-center text-xs text-muted-foreground">
          These are AI-generated recommendations. AI can make mistakes. Please
          use your professional judgment when implementing these tips, as they
          are provided &quot;as-is&quot;.
        </p>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-4 text-xs text-muted-foreground">
          <span>© {new Date().getFullYear()} Agent Ready</span>
          <a
            href="https://github.com/safa0/isitagentready"
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground"
          >
            GitHub
          </a>
        </div>
      </footer>
    </div>
  );
}
