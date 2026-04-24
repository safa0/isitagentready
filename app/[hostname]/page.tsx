import Link from "next/link";
import type { CheckId, CheckResult, Profile, ScanResponse } from "@/lib/schema";
import {
  ALL_CHECK_IDS,
  CHECK_CATEGORY,
  DEFAULT_ENABLED_CHECKS,
  computeCategoryScores,
  scoreScan,
} from "@/lib/engine/scoring";
import { runScan, ScanUrlError } from "@/lib/engine";
import { ScanForm } from "@/components/ScanForm";
import { ScoreGauge } from "@/components/ScoreGauge";
import { CategoryCard } from "@/components/CategoryCard";
import { CheckRow } from "@/components/CheckRow";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Accordion } from "@/components/ui/accordion";

/**
 * /[hostname] — results page.
 *
 * Reads the URL, profile, and enabledChecks from the query string, runs the
 * scan server-side with a 25s abort signal, and renders the full evidence
 * package. If `runScan` throws (SSRF, DNS, timeout), we render a friendly
 * error card instead of bubbling up a 500.
 */

export const dynamic = "force-dynamic";

const SCAN_TIMEOUT_MS = 25_000;

const CATEGORY_LABEL: Readonly<Record<string, string>> = {
  discoverability: "Discoverability",
  contentAccessibility: "Content",
  botAccessControl: "Bot Access Control",
  discovery: "API, Auth, MCP & Skill Discovery",
  commerce: "Commerce",
};

const CATEGORY_ORDER = [
  "discoverability",
  "contentAccessibility",
  "botAccessControl",
  "discovery",
  "commerce",
] as const;

type SearchParams = Record<string, string | string[] | undefined>;

interface PageProps {
  readonly params: Promise<{ readonly hostname: string }>;
  readonly searchParams: Promise<SearchParams>;
}

function pickString(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function parseProfile(raw: string | undefined): Profile | undefined {
  if (raw === "all" || raw === "content" || raw === "apiApp") return raw;
  return undefined;
}

function parseEnabledChecks(
  raw: string | undefined,
): readonly CheckId[] | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  const all = new Set<CheckId>(ALL_CHECK_IDS);
  const parts = raw.split(",").map((s) => s.trim());
  const picked: CheckId[] = [];
  for (const p of parts) {
    if (all.has(p as CheckId)) picked.push(p as CheckId);
  }
  return picked.length > 0 ? picked : undefined;
}

function buildTargetUrl(
  hostname: string,
  urlParam: string | undefined,
): string {
  if (urlParam !== undefined && urlParam.length > 0) return urlParam;
  return `https://${hostname}`;
}

function flattenChecks(
  response: ScanResponse,
): Record<CheckId, CheckResult> {
  const flat: Partial<Record<CheckId, CheckResult>> = {};
  for (const id of ALL_CHECK_IDS) {
    const cat = CHECK_CATEGORY[id];
    const bucket = response.checks[cat] as unknown as Record<
      string,
      CheckResult
    >;
    const entry = bucket[id];
    if (entry !== undefined) flat[id] = entry;
  }
  return flat as Record<CheckId, CheckResult>;
}

function LevelPill({
  level,
  levelName,
}: {
  readonly level: number;
  readonly levelName: string;
}): React.JSX.Element {
  return (
    <div
      data-slot="level-pill"
      className="inline-flex items-center gap-2 rounded-full bg-[#F6821F]/10 px-4 py-1.5 text-sm font-semibold text-[#F6821F]"
    >
      <span>Level {level}</span>
      <span aria-hidden="true">·</span>
      <span>{levelName}</span>
    </div>
  );
}

function ErrorCard({
  message,
  hostname,
}: {
  readonly message: string;
  readonly hostname: string;
}): React.JSX.Element {
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 rounded-2xl border border-red-500/40 bg-red-500/5 p-6 text-sm">
      <h2 className="text-lg font-semibold tracking-tight text-red-600 dark:text-red-400">
        Scan failed
      </h2>
      <p className="text-foreground/80">{message}</p>
      <div className="flex flex-wrap gap-3">
        <Link
          href={`/${hostname}`}
          className="rounded-md border border-border px-3 py-1.5 font-medium hover:bg-muted"
        >
          Retry
        </Link>
        <Link
          href="/"
          className="rounded-md border border-border px-3 py-1.5 font-medium hover:bg-muted"
        >
          Scan another site
        </Link>
      </div>
    </div>
  );
}

export default async function ResultsPage(
  props: PageProps,
): Promise<React.JSX.Element> {
  const { hostname: hostnameRaw } = await props.params;
  const hostname = decodeURIComponent(hostnameRaw);
  const search = await props.searchParams;

  const urlParam = pickString(search.url);
  const profileParam = parseProfile(pickString(search.profile));
  const enabledChecksParam = parseEnabledChecks(pickString(search.enabledChecks));
  const targetUrl = buildTargetUrl(hostname, urlParam);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);

  let response: ScanResponse;
  try {
    response = await runScan(targetUrl, {
      profile: profileParam,
      enabledChecks: enabledChecksParam,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const message =
      err instanceof ScanUrlError
        ? err.message
        : controller.signal.aborted
          ? "The scan took longer than 25 seconds and was cancelled."
          : "Something went wrong while scanning. Try again or scan a different URL.";
    return (
      <div className="flex min-h-full flex-col bg-background">
        <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-6">
          <Link href="/" className="text-sm font-semibold tracking-tight">
            Agent Ready
          </Link>
          <ThemeToggle />
        </header>
        <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-10">
          <ScanForm
            prefilledUrl={targetUrl}
            profile={profileParam}
            enabledChecks={enabledChecksParam}
          />
          <ErrorCard message={message} hostname={hostname} />
        </main>
      </div>
    );
  } finally {
    clearTimeout(timer);
  }

  const flat = flattenChecks(response);
  const scoreOpts = {
    isCommerce: response.isCommerce,
    enabledChecks: enabledChecksParam ?? DEFAULT_ENABLED_CHECKS,
  } as const;
  const score = scoreScan(flat, scoreOpts);
  const byCategory = computeCategoryScores(flat, scoreOpts);

  // Render the commerce category only when the site advertises commerce
  // signals — otherwise scoring excludes it, and the evidence rows are all
  // neutral/skipped.
  const visibleCategories = CATEGORY_ORDER.filter((c) => {
    if (c === "commerce" && !response.isCommerce) return false;
    return true;
  });

  const firstFailId = ALL_CHECK_IDS.find((id) => {
    const r = flat[id];
    return r !== undefined && r.status === "fail";
  });

  return (
    <div className="flex min-h-full flex-col bg-background">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-6">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm font-semibold tracking-tight"
        >
          <span
            aria-hidden="true"
            className="inline-flex size-7 items-center justify-center rounded-lg bg-[#F6821F]/10 text-[#F6821F]"
          >
            <svg viewBox="0 0 24 24" fill="none" className="size-4">
              <path
                d="M4 14a5 5 0 015-5h1a6 6 0 0110.87 3.5A3.5 3.5 0 0119 19H7a3 3 0 01-3-3v-2z"
                fill="currentColor"
              />
            </svg>
          </span>
          Agent Ready
        </Link>
        <ThemeToggle />
      </header>

      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-10 px-6 pb-16 pt-4">
        <section className="flex flex-col gap-3">
          <ScanForm
            prefilledUrl={targetUrl}
            profile={profileParam}
            enabledChecks={enabledChecksParam}
          />
        </section>

        <section className="flex flex-col items-center gap-4">
          <ScoreGauge score={score} size="lg" />
          <LevelPill level={response.level} levelName={response.levelName} />
          <p className="text-xs text-muted-foreground">
            Last scanned {new Date(response.scannedAt).toLocaleString()}
          </p>
        </section>

        <section className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {(Object.keys(byCategory) as (keyof typeof byCategory)[]).map(
            (cat) => {
              if (cat === "commerce" && !response.isCommerce) return null;
              const entry = byCategory[cat];
              return (
                <CategoryCard
                  key={cat}
                  category={cat}
                  score={entry.score}
                  passes={entry.passes}
                  fails={entry.fails}
                />
              );
            },
          )}
        </section>

        {firstFailId !== undefined ? (
          <section className="flex justify-center">
            <a
              href={`#check-${firstFailId}`}
              className="inline-flex items-center gap-2 rounded-full bg-[#F6821F] px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[#E07719]"
            >
              <span aria-hidden="true">↓</span>
              Improve the score
            </a>
          </section>
        ) : null}

        <section className="flex flex-col gap-6">
          {visibleCategories.map((cat) => {
            const ids = ALL_CHECK_IDS.filter((id) => CHECK_CATEGORY[id] === cat);
            const categoryScore = byCategory[cat];
            return (
              <div key={cat} className="flex flex-col gap-3">
                <header className="flex items-baseline justify-between gap-2">
                  <h2 className="text-lg font-semibold tracking-tight">
                    {CATEGORY_LABEL[cat] ?? cat}
                  </h2>
                  <span className="text-xs text-muted-foreground">
                    {categoryScore.passes}/{categoryScore.total}
                  </span>
                </header>
                <Accordion className="flex flex-col gap-2">
                  {ids.map((id) => {
                    const result = flat[id];
                    if (result === undefined) return null;
                    return (
                      <div key={id} id={`check-${id}`}>
                        <CheckRow checkId={id} check={result} />
                      </div>
                    );
                  })}
                </Accordion>
              </div>
            );
          })}
        </section>

        <section className="flex justify-center">
          <Link
            href="/"
            className="text-sm text-[#F6821F] hover:underline"
          >
            ← Scan another site
          </Link>
        </section>
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
