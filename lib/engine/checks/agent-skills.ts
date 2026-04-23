/**
 * Discovery check: `agentSkills`.
 *
 * Specification
 * -------------
 * - GET `/.well-known/agent-skills/index.json` (Agent Skills Discovery RFC
 *   v0.2.0 path) on the origin.
 * - On 404, fall back to the legacy `/.well-known/skills/index.json` path.
 *   The reference scanner uses this same fallback — see
 *   `research/raw/scan-cf-dev.json` for an oracle example.
 * - Parse the JSON body. Expect a `skills: []` array; each entry may carry
 *   `{ id | name, description, url | href }` per RFC v0.2.0 and the
 *   FINDINGS §3 shorthand `{ id, name, href }`.
 * - Resolve the first 3 skill hrefs (SKILL.md URLs). Pass iff the index is
 *   valid JSON AND at least one skill URL responds 200 with a non-empty body.
 *
 * Evidence timeline (pass path):
 *   fetch (index) -> validate (parse JSON) -> validate (count skills)
 *     -> fetch (skill 1) [-> fetch (skill 2) [-> fetch (skill 3)]]
 *     -> validate (resolution count) -> conclude
 *
 * Evidence timeline (fail path — no index on either path):
 *   fetch (v0.2.0, neutral "trying legacy") -> fetch (legacy, negative 404)
 *     -> conclude
 *
 * This fail shape matches the Cloudflare oracle fail fixtures exactly.
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

const V0_2_PATH = "/.well-known/agent-skills/index.json";
const LEGACY_PATH = "/.well-known/skills/index.json";

const FETCH_V0_2_LABEL = "GET /.well-known/agent-skills/index.json";
const FETCH_LEGACY_LABEL = "GET /.well-known/skills/index.json";
const PARSE_JSON_LABEL = "Parse skills index";
const COUNT_SKILLS_LABEL = "Count skills";
const VALIDATE_RESOLUTION_LABEL = "Resolve skill references";
const CONCLUDE_LABEL = "Conclusion";

const FAIL_NOT_FOUND_MESSAGE = "Agent Skills index not found";
const FAIL_INVALID_JSON_MESSAGE = "Agent Skills index is not valid JSON";
const FAIL_NO_SKILLS_MESSAGE = "Agent Skills index does not declare any skills";
const FAIL_NO_RESOLUTION_MESSAGE =
  "Agent Skills index found but no referenced skills resolve";
const PASS_MESSAGE = "Agent Skills index exists with valid JSON";

/** Resolution cap — matches the task spec ("first 3 skill hrefs"). */
const SKILL_RESOLUTION_LIMIT = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SkillEntry {
  readonly href: string;
  readonly id?: string;
  readonly name?: string;
}

function normaliseSkillEntries(skills: readonly unknown[]): SkillEntry[] {
  const out: SkillEntry[] = [];
  for (const entry of skills) {
    if (typeof entry !== "object" || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    const hrefRaw = obj.href ?? obj.url;
    if (typeof hrefRaw !== "string" || hrefRaw.length === 0) continue;
    const id = typeof obj.id === "string" ? obj.id : undefined;
    const name = typeof obj.name === "string" ? obj.name : undefined;
    out.push({ href: hrefRaw, id, name });
  }
  return out;
}

/** Legacy heuristic — matches the reference scanner (cf-dev fixture). */
const LEGACY_SPEC_VERSION = "0.1.0";

function extractSpecVersion(
  parsed: Record<string, unknown>,
  indexPath: string,
): string | undefined {
  const schema = parsed.$schema;
  if (typeof schema === "string") {
    // https://schemas.agentskills.io/discovery/0.2.0/schema.json
    const match = /discovery\/(\d+\.\d+(?:\.\d+)?)\//.exec(schema);
    if (match?.[1] !== undefined) return match[1];
  }
  // Legacy fallback: when we hit /.well-known/skills/index.json and the body
  // carries no $schema, the reference scanner reports specVersion "0.1.0"
  // (see research/raw/scan-cf-dev.json). Mirror that behaviour.
  if (indexPath === LEGACY_PATH) return LEGACY_SPEC_VERSION;
  return undefined;
}

function skillDisplayName(skill: SkillEntry): string {
  return skill.id ?? skill.name ?? skill.href;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function checkAgentSkills(
  ctx: ScanContext,
): Promise<CheckResult> {
  const started = Date.now();
  const evidence: EvidenceStep[] = [];

  // 1. Try the v0.2.0 path first.
  const v0Outcome = await ctx.fetch(V0_2_PATH);
  let indexOutcome: FetchOutcome | undefined;
  let indexPath = V0_2_PATH;

  if (v0Outcome.response?.status === 200) {
    evidence.push(
      fetchToStep(v0Outcome, FETCH_V0_2_LABEL, {
        outcome: "positive",
        summary: `Received 200 response with content-type: ${
          v0Outcome.response.headers["content-type"] ?? "unknown"
        }`,
      }),
    );
    indexOutcome = v0Outcome;
  } else {
    // Record the v0.2.0 attempt as neutral ("trying legacy path") and fall
    // back to the legacy path — matches the oracle's evidence shape.
    evidence.push(
      fetchToStep(v0Outcome, FETCH_V0_2_LABEL, {
        outcome: "neutral",
        summary: v0Outcome.response
          ? `v0.2.0 path returned ${v0Outcome.response.status} — trying legacy path`
          : `v0.2.0 path failed (${v0Outcome.error ?? "transport error"}) — trying legacy path`,
      }),
    );

    const legacyOutcome = await ctx.fetch(LEGACY_PATH);
    if (legacyOutcome.response?.status === 200) {
      evidence.push(
        fetchToStep(legacyOutcome, FETCH_LEGACY_LABEL, {
          outcome: "positive",
          summary: `Received 200 response with content-type: ${
            legacyOutcome.response.headers["content-type"] ?? "unknown"
          }`,
        }),
      );
      indexOutcome = legacyOutcome;
      indexPath = LEGACY_PATH;
    } else {
      evidence.push(
        fetchToStep(legacyOutcome, FETCH_LEGACY_LABEL, {
          outcome: "negative",
          summary: legacyOutcome.response
            ? `Server returned ${legacyOutcome.response.status} — Agent Skills index not found`
            : `Transport error: ${legacyOutcome.error ?? "unknown"}`,
        }),
      );
      evidence.push(
        makeStep("conclude", CONCLUDE_LABEL, {
          outcome: "negative",
          summary: FAIL_NOT_FOUND_MESSAGE,
        }),
      );
      return {
        status: "fail",
        message: FAIL_NOT_FOUND_MESSAGE,
        evidence,
        durationMs: Date.now() - started,
      };
    }
  }

  // 2. Parse the JSON body.
  let parsed: unknown;
  try {
    parsed = JSON.parse(indexOutcome.body ?? "");
  } catch (err) {
    const parseErr = err instanceof Error ? err.message : String(err);
    evidence.push(
      makeStep("validate", PARSE_JSON_LABEL, {
        outcome: "negative",
        summary: `Failed to parse JSON body: ${parseErr}`,
      }),
    );
    evidence.push(
      makeStep("conclude", CONCLUDE_LABEL, {
        outcome: "negative",
        summary: FAIL_INVALID_JSON_MESSAGE,
      }),
    );
    return {
      status: "fail",
      message: FAIL_INVALID_JSON_MESSAGE,
      evidence,
      durationMs: Date.now() - started,
    };
  }

  if (typeof parsed !== "object" || parsed === null) {
    evidence.push(
      makeStep("validate", PARSE_JSON_LABEL, {
        outcome: "negative",
        summary: "Index root is not a JSON object",
      }),
    );
    evidence.push(
      makeStep("conclude", CONCLUDE_LABEL, {
        outcome: "negative",
        summary: FAIL_INVALID_JSON_MESSAGE,
      }),
    );
    return {
      status: "fail",
      message: FAIL_INVALID_JSON_MESSAGE,
      evidence,
      durationMs: Date.now() - started,
    };
  }

  const indexObj = parsed as Record<string, unknown>;
  const rawSkills = Array.isArray(indexObj.skills) ? indexObj.skills : null;

  if (rawSkills === null || rawSkills.length === 0) {
    evidence.push(
      makeStep("validate", COUNT_SKILLS_LABEL, {
        outcome: "negative",
        summary:
          rawSkills === null
            ? "Index JSON does not contain a 'skills' array"
            : "Index 'skills' array is empty",
      }),
    );
    evidence.push(
      makeStep("conclude", CONCLUDE_LABEL, {
        outcome: "negative",
        summary: FAIL_NO_SKILLS_MESSAGE,
      }),
    );
    return {
      status: "fail",
      message: FAIL_NO_SKILLS_MESSAGE,
      evidence,
      durationMs: Date.now() - started,
    };
  }

  evidence.push(
    makeStep("validate", COUNT_SKILLS_LABEL, {
      outcome: "neutral",
      summary: `Found "skills" array with ${rawSkills.length} entries`,
    }),
  );

  // 3. Resolve up to the first N skill hrefs.
  const skills = normaliseSkillEntries(rawSkills);
  const toResolve = skills.slice(0, SKILL_RESOLUTION_LIMIT);
  let resolvedCount = 0;

  for (const skill of toResolve) {
    let target: URL;
    try {
      target = ctx.resolve(skill.href);
    } catch {
      evidence.push(
        makeStep(
          "validate",
          `Resolve skill ${skillDisplayName(skill)}`,
          {
            outcome: "negative",
            summary: `Could not resolve skill href: ${skill.href}`,
          },
        ),
      );
      continue;
    }
    const skillOutcome = await ctx.fetch(target.toString());
    const skillLabel = `GET ${target.pathname}`;
    if (
      skillOutcome.response?.status === 200 &&
      skillOutcome.body !== undefined &&
      skillOutcome.body.length > 0
    ) {
      resolvedCount++;
      evidence.push(
        fetchToStep(skillOutcome, skillLabel, {
          outcome: "positive",
          summary: `Skill ${skillDisplayName(skill)} resolved`,
        }),
      );
    } else {
      evidence.push(
        fetchToStep(skillOutcome, skillLabel, {
          outcome: "negative",
          summary: skillOutcome.response
            ? `Skill ${skillDisplayName(skill)} returned ${skillOutcome.response.status}`
            : `Skill ${skillDisplayName(skill)} fetch failed: ${skillOutcome.error ?? "unknown"}`,
        }),
      );
    }
  }

  // 4. Resolution gate.
  if (resolvedCount === 0) {
    evidence.push(
      makeStep("validate", VALIDATE_RESOLUTION_LABEL, {
        outcome: "negative",
        summary: `None of the first ${toResolve.length} skill href(s) resolved with content`,
      }),
    );
    evidence.push(
      makeStep("conclude", CONCLUDE_LABEL, {
        outcome: "negative",
        summary: FAIL_NO_RESOLUTION_MESSAGE,
      }),
    );
    return {
      status: "fail",
      message: FAIL_NO_RESOLUTION_MESSAGE,
      details: {
        skillCount: rawSkills.length,
        resolvedSkills: 0,
        path: indexPath,
      },
      evidence,
      durationMs: Date.now() - started,
    };
  }

  evidence.push(
    makeStep("validate", VALIDATE_RESOLUTION_LABEL, {
      outcome: "positive",
      summary: `Resolved ${resolvedCount}/${toResolve.length} referenced skills`,
    }),
  );
  evidence.push(
    makeStep("conclude", CONCLUDE_LABEL, {
      outcome: "positive",
      summary: PASS_MESSAGE,
    }),
  );

  const details: Record<string, unknown> = {
    skillCount: rawSkills.length,
    resolvedSkills: resolvedCount,
    path: indexPath,
  };
  const specVersion = extractSpecVersion(indexObj, indexPath);
  if (specVersion !== undefined) {
    details.specVersion = specVersion;
  }

  return {
    status: "pass",
    message: PASS_MESSAGE,
    details,
    evidence,
    durationMs: Date.now() - started,
  };
}
