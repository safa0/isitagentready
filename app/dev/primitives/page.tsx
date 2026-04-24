import { notFound } from "next/navigation";
import { ScoreGauge } from "@/components/ScoreGauge";
import { CategoryCard } from "@/components/CategoryCard";
import { CheckRow } from "@/components/CheckRow";
import { EvidenceTimeline } from "@/components/EvidenceTimeline";
import { CopyPromptButton } from "@/components/CopyPromptButton";
import { ScanResponseSchema, type CheckId } from "@/lib/schema";
import {
  ALL_CHECK_IDS,
  CHECK_CATEGORY,
  DEFAULT_ENABLED_CHECKS,
  computeCategoryScores,
  scoreScan,
} from "@/lib/engine/scoring";
import cfDevRaw from "@/research/raw/scan-cf-dev.json" with { type: "json" };

/**
 * Dev-only smoke route for the Phase 4 UI primitives. Only available in
 * non-production builds — production returns 404 so we don't ship this route
 * publicly.
 */
// Rendered at request time so the VERCEL_ENV gate gets live values (the build
// host sets NODE_ENV=production but VERCEL_ENV=preview, so prerendering would
// render the page into the preview bundle).
export const dynamic = "force-dynamic";

function normalizeFixture(raw: unknown): unknown {
  // The oracle fixtures are captured from live scans and may pre-date schema
  // additions (e.g. per-check durationMs). Fill missing numeric fields with 0
  // so the dev smoke route renders even if a fixture lags behind the schema.
  if (raw === null || typeof raw !== "object") return raw;
  const cloned = JSON.parse(JSON.stringify(raw)) as {
    checks?: Record<string, Record<string, Record<string, unknown>>>;
  };
  const checks = cloned.checks;
  if (checks) {
    for (const cat of Object.values(checks)) {
      for (const entry of Object.values(cat)) {
        if (entry !== null && typeof entry === "object" && entry.durationMs === undefined) {
          entry.durationMs = 0;
        }
      }
    }
  }
  return cloned;
}

export default function DevPrimitivesPage(): React.JSX.Element {
  if (process.env.VERCEL_ENV === "production") notFound();

  const parsed = ScanResponseSchema.parse(normalizeFixture(cfDevRaw));

  // Flatten ChecksBlock → Record<CheckId, CheckResult> so we can reuse scoring.
  const flat = {} as Record<
    CheckId,
    (typeof parsed.checks.discoverability.robotsTxt)
  >;
  for (const id of ALL_CHECK_IDS) {
    const cat = CHECK_CATEGORY[id];
    const bucket = parsed.checks[cat] as Record<string, unknown>;
    const entry = bucket[id];
    if (entry === undefined) continue;
    flat[id] = entry as (typeof parsed.checks.discoverability.robotsTxt);
  }

  const opts = {
    isCommerce: parsed.isCommerce,
    enabledChecks: DEFAULT_ENABLED_CHECKS,
  } as const;
  const score = scoreScan(flat, opts);
  const byCategory = computeCategoryScores(flat, opts);

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-10 p-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          Phase 4 primitives — dev smoke
        </h1>
        <p className="text-sm text-muted-foreground">
          Rendering the Cloudflare Developers fixture ({parsed.url}) through
          every new component.
        </p>
      </header>

      <section className="flex flex-col items-center gap-4">
        <ScoreGauge score={score} size="lg" />
        <div className="inline-flex items-center gap-2 rounded-full bg-[#F6821F]/10 px-3 py-1 text-sm font-medium text-[#F6821F]">
          Level {parsed.level}: {parsed.levelName}
        </div>
      </section>

      <section className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {(Object.keys(byCategory) as (keyof typeof byCategory)[]).map((cat) => {
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
        })}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Checks</h2>
        {ALL_CHECK_IDS.map((id) => {
          const result = flat[id];
          if (result === undefined) return null;
          return <CheckRow key={id} checkId={id} check={result} />;
        })}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight">
          Standalone evidence timeline
        </h2>
        <EvidenceTimeline
          evidence={parsed.checks.discoverability.robotsTxt.evidence}
          durationMs={parsed.checks.discoverability.robotsTxt.durationMs}
        />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight">
          Standalone copy-prompt button
        </h2>
        <CopyPromptButton checkId="apiCatalog" />
      </section>
    </main>
  );
}
