/**
 * Level ladder — PLAN §Phases Phase 3.
 *
 *   L0 Not Ready         (baseline)
 *   L1 Basic Web Presence   robotsTxt, sitemap
 *   L2 Bot-Aware            L1 + robotsTxtAiRules, contentSignals
 *   L3 Agent-Readable       L2 + markdownNegotiation
 *   L4 Agent-Integrated     L3 + linkHeaders, agentSkills
 *   L5 Agent-Native         L4 + apiCatalog, oauthProtectedResource,
 *                                mcpServerCard, a2aAgentCard
 */

import type { CheckId, CheckResult, Level, LevelName } from "@/lib/schema";

// ---------------------------------------------------------------------------
// Level table
// ---------------------------------------------------------------------------

interface LevelSpec {
  readonly level: Level;
  readonly name: LevelName;
  /** Checks required *incrementally* (i.e. not including lower levels). */
  readonly increments: readonly CheckId[];
}

export const LEVEL_TABLE: readonly LevelSpec[] = [
  { level: 0, name: "Not Ready", increments: [] },
  { level: 1, name: "Basic Web Presence", increments: ["robotsTxt", "sitemap"] },
  {
    level: 2,
    name: "Bot-Aware",
    increments: ["robotsTxtAiRules", "contentSignals"],
  },
  {
    level: 3,
    name: "Agent-Readable",
    increments: ["markdownNegotiation"],
  },
  {
    level: 4,
    name: "Agent-Integrated",
    increments: ["linkHeaders", "agentSkills"],
  },
  {
    level: 5,
    name: "Agent-Native",
    increments: [
      "apiCatalog",
      "oauthProtectedResource",
      "mcpServerCard",
      "a2aAgentCard",
    ],
  },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LevelOutcome {
  readonly level: Level;
  readonly levelName: LevelName;
  /**
   * The next level the site should aim for, with the list of required checks
   * it is missing. `null` when the site has already reached L5.
   */
  readonly nextLevel: {
    readonly level: Level;
    readonly name: LevelName;
    readonly requirements: readonly CheckId[];
  } | null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function isPass(r: CheckResult | undefined): boolean {
  return r !== undefined && r.status === "pass";
}

function missingForLevel(
  spec: LevelSpec,
  results: Record<CheckId, CheckResult>,
): CheckId[] {
  return spec.increments.filter((id) => !isPass(results[id]));
}

export function determineLevel(
  results: Record<CheckId, CheckResult>,
): LevelOutcome {
  let current: LevelSpec = LEVEL_TABLE[0]!;
  for (let i = 1; i < LEVEL_TABLE.length; i++) {
    const spec = LEVEL_TABLE[i]!;
    const missing = missingForLevel(spec, results);
    if (missing.length === 0) {
      current = spec;
    } else {
      break;
    }
  }

  if (current.level === 5) {
    return {
      level: 5,
      levelName: current.name,
      nextLevel: null,
    };
  }

  const nextSpec = LEVEL_TABLE[current.level + 1]!;
  return {
    level: current.level,
    levelName: current.name,
    nextLevel: {
      level: nextSpec.level,
      name: nextSpec.name,
      requirements: missingForLevel(nextSpec, results),
    },
  };
}
