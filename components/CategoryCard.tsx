import type { CategoryId } from "@/lib/schema";
import { ScoreGauge } from "@/components/ScoreGauge";
import { cn } from "@/lib/utils";

/**
 * Compact card for a single category score with pass / fail pill counts.
 * Server component — purely presentational, no state.
 */

interface CategoryCardProps {
  readonly category: CategoryId;
  readonly score: number;
  readonly passes: number;
  readonly fails: number;
}

const CATEGORY_LABEL: Readonly<Record<CategoryId, string>> = {
  discoverability: "Discoverability",
  contentAccessibility: "Content Accessibility",
  botAccessControl: "Bot Access Control",
  discovery: "Discovery",
  commerce: "Commerce",
};

export function CategoryCard({
  category,
  score,
  passes,
  fails,
}: CategoryCardProps): React.JSX.Element {
  return (
    <div
      data-slot="category-card"
      data-category={category}
      className={cn(
        "flex flex-col items-center gap-3 rounded-xl border border-border bg-[#FDF6EE] p-4",
        "shadow-sm dark:bg-card",
      )}
    >
      <h3 className="text-sm font-medium tracking-tight text-foreground">
        {CATEGORY_LABEL[category]}
      </h3>
      <ScoreGauge score={score} size="sm" />
      <div className="flex items-center gap-2 text-xs">
        <span
          data-testid="category-passes"
          className={cn(
            "inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 font-medium text-green-600",
            "dark:text-green-400",
          )}
        >
          <span aria-hidden="true">✓</span>
          <span className="tabular-nums">{passes}</span>
        </span>
        <span
          data-testid="category-fails"
          className={cn(
            "inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 font-medium text-red-600",
            "dark:text-red-400",
          )}
        >
          <span aria-hidden="true">✗</span>
          <span className="tabular-nums">{fails}</span>
        </span>
      </div>
    </div>
  );
}
