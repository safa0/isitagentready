import type { EvidenceAction, EvidenceStep } from "@/lib/schema";
import { cn } from "@/lib/utils";

/**
 * Vertical timeline of evidence steps for one check.
 *
 * Server component — uses native `<details>` for collapsible request/response
 * header tables, so no client-side state is needed.
 */

interface EvidenceTimelineProps {
  readonly evidence: readonly EvidenceStep[];
  readonly durationMs: number;
}

const ACTION_GLYPH: Readonly<Record<EvidenceAction, string>> = {
  fetch: "↓",
  parse: "⋯",
  validate: "✓",
  navigate: "→",
  conclude: "◉",
};

const OUTCOME_CLASS: Readonly<
  Record<"positive" | "negative" | "neutral", string>
> = {
  positive: "text-green-600 dark:text-green-400",
  negative: "text-red-600 dark:text-red-400",
  neutral: "text-muted-foreground",
};

function HeaderTable({
  headers,
}: {
  readonly headers: Readonly<Record<string, string>>;
}): React.JSX.Element | null {
  const entries = Object.entries(headers);
  if (entries.length === 0) return null;
  return (
    <table className="w-full border-collapse text-left text-xs">
      <tbody>
        {entries.map(([name, value]) => (
          <tr key={name} className="border-b border-border/60 last:border-0">
            <th
              scope="row"
              className="whitespace-nowrap py-1 pr-3 font-mono font-medium text-muted-foreground"
            >
              {name}
            </th>
            <td className="break-all py-1 font-mono">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StepCard({
  step,
  index,
}: {
  readonly step: EvidenceStep;
  readonly index: number;
}): React.JSX.Element {
  const hasRequestHeaders =
    step.request?.headers !== undefined &&
    Object.keys(step.request.headers).length > 0;
  const hasResponseHeaders =
    step.response?.headers !== undefined &&
    Object.keys(step.response.headers).length > 0;
  const bodyPreview = step.response?.bodyPreview;

  return (
    <li
      data-slot="evidence-step"
      data-action={step.action}
      className="relative flex gap-3 pb-4 pl-0"
    >
      <span
        data-testid={`evidence-icon-${step.action}`}
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold",
          OUTCOME_CLASS[step.finding.outcome],
        )}
      >
        {ACTION_GLYPH[step.action]}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            data-testid="evidence-step-label"
            className="text-sm font-medium text-foreground"
          >
            {step.label}
          </span>
          {step.response !== undefined ? (
            <span
              data-testid="evidence-status"
              className={cn(
                "rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] tabular-nums",
                OUTCOME_CLASS[step.finding.outcome],
              )}
            >
              {step.response.status}
            </span>
          ) : null}
        </div>
        <p
          className={cn(
            "mt-0.5 text-xs",
            OUTCOME_CLASS[step.finding.outcome],
          )}
        >
          {step.finding.summary}
        </p>

        {step.request !== undefined ? (
          <details
            className="mt-2 rounded border border-border bg-background/50 px-2 py-1 text-xs"
            data-testid={`evidence-request-${index}`}
          >
            <summary className="cursor-pointer font-medium text-muted-foreground">
              Request ({step.request.method} {step.request.url})
            </summary>
            <div className="pt-2">
              {hasRequestHeaders && step.request.headers !== undefined ? (
                <HeaderTable headers={step.request.headers} />
              ) : (
                <p className="text-muted-foreground">No headers.</p>
              )}
            </div>
          </details>
        ) : null}

        {step.response !== undefined ? (
          <details
            className="mt-2 rounded border border-border bg-background/50 px-2 py-1 text-xs"
            data-testid={`evidence-response-${index}`}
          >
            <summary className="cursor-pointer font-medium text-muted-foreground">
              Response ({step.response.status} {step.response.statusText})
            </summary>
            <div className="flex flex-col gap-2 pt-2">
              {hasResponseHeaders ? (
                <HeaderTable headers={step.response.headers} />
              ) : (
                <p className="text-muted-foreground">No headers.</p>
              )}
              {bodyPreview !== undefined && bodyPreview.length > 0 ? (
                <pre className="max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-[11px] leading-snug">
                  {bodyPreview}
                </pre>
              ) : null}
            </div>
          </details>
        ) : null}
      </div>
    </li>
  );
}

export function EvidenceTimeline({
  evidence,
  durationMs,
}: EvidenceTimelineProps): React.JSX.Element {
  if (evidence.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
        No evidence recorded for this check.
      </div>
    );
  }
  return (
    <div data-slot="evidence-timeline" className="flex flex-col gap-2">
      <ol className="flex flex-col">
        {evidence.map((step, idx) => (
          <StepCard
            // Steps are static per render and never reordered; index is stable.
            key={`${step.action}-${step.label}`}
            step={step}
            index={idx}
          />
        ))}
      </ol>
      <footer
        data-testid="evidence-total-duration"
        className="mt-2 flex items-center justify-end text-xs text-muted-foreground"
      >
        Total:{" "}
        <span className="ml-1 font-mono tabular-nums">{durationMs}</span>
        <span className="ml-0.5">ms</span>
      </footer>
    </div>
  );
}
