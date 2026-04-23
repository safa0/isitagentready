/**
 * Zod schemas for the Agent Readiness Scanner public API.
 *
 * Shape mirrors research/FINDINGS.md §4 (reverse-engineered from the live
 * isitagentready.com /api/scan response) verbatim. Do not change field names
 * without coordinating with the consumer contract (fixture round-trip tests +
 * MCP tool schema).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums / primitives
// ---------------------------------------------------------------------------

export const CheckIdSchema = z.enum([
  // discoverability
  "robotsTxt",
  "sitemap",
  "linkHeaders",
  // contentAccessibility
  "markdownNegotiation",
  // botAccessControl
  "robotsTxtAiRules",
  "contentSignals",
  "webBotAuth",
  // discovery (API/Auth/MCP/Skills)
  "apiCatalog",
  "oauthDiscovery",
  "oauthProtectedResource",
  "mcpServerCard",
  "a2aAgentCard",
  "agentSkills",
  "webMcp",
  // commerce
  "x402",
  "mpp",
  "ucp",
  "acp",
  "ap2",
]);
export type CheckId = z.infer<typeof CheckIdSchema>;

export const CategoryIdSchema = z.enum([
  "discoverability",
  "contentAccessibility",
  "botAccessControl",
  "discovery",
  "commerce",
]);
export type CategoryId = z.infer<typeof CategoryIdSchema>;

export const ProfileSchema = z.enum(["all", "content", "apiApp"]);
export type Profile = z.infer<typeof ProfileSchema>;

export const CheckStatusSchema = z.enum(["pass", "fail", "neutral"]);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const FindingOutcomeSchema = z.enum(["positive", "negative", "neutral"]);
export type FindingOutcome = z.infer<typeof FindingOutcomeSchema>;

export const EvidenceActionSchema = z.enum([
  "fetch",
  "parse",
  "validate",
  "navigate",
  "conclude",
]);
export type EvidenceAction = z.infer<typeof EvidenceActionSchema>;

export const LevelSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);
export type Level = z.infer<typeof LevelSchema>;

export const LevelNameSchema = z.enum([
  "Not Ready",
  "Basic Web Presence",
  "Bot-Aware",
  "Agent-Readable",
  "Agent-Integrated",
  "Agent-Native",
]);
export type LevelName = z.infer<typeof LevelNameSchema>;

// ---------------------------------------------------------------------------
// Evidence timeline
// ---------------------------------------------------------------------------

export const EvidenceRequestSchema = z.object({
  url: z.string(),
  method: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
});
export type EvidenceRequest = z.infer<typeof EvidenceRequestSchema>;

export const EvidenceResponseSchema = z.object({
  status: z.number(),
  statusText: z.string(),
  headers: z.record(z.string(), z.string()),
  // Truncated response body preview. Matches the real Cloudflare scanner
  // output: first 500 chars of the body, with "..." suffix when truncated.
  bodyPreview: z.string().optional(),
});
export type EvidenceResponse = z.infer<typeof EvidenceResponseSchema>;

export const EvidenceFindingSchema = z.object({
  outcome: FindingOutcomeSchema,
  summary: z.string(),
});
export type EvidenceFinding = z.infer<typeof EvidenceFindingSchema>;

export const EvidenceStepSchema = z.object({
  action: EvidenceActionSchema,
  label: z.string(),
  request: EvidenceRequestSchema.optional(),
  response: EvidenceResponseSchema.optional(),
  finding: EvidenceFindingSchema,
});
export type EvidenceStep = z.infer<typeof EvidenceStepSchema>;

// ---------------------------------------------------------------------------
// Per-check result
// ---------------------------------------------------------------------------

export const CheckResultSchema = z.object({
  status: CheckStatusSchema,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
  evidence: z.array(EvidenceStepSchema),
  durationMs: z.number(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

// ---------------------------------------------------------------------------
// Categorised checks block (exact API surface)
// ---------------------------------------------------------------------------

export const ChecksBlockSchema = z.object({
  discoverability: z.object({
    robotsTxt: CheckResultSchema,
    sitemap: CheckResultSchema,
    linkHeaders: CheckResultSchema,
  }),
  contentAccessibility: z.object({
    markdownNegotiation: CheckResultSchema,
  }),
  botAccessControl: z.object({
    robotsTxtAiRules: CheckResultSchema,
    contentSignals: CheckResultSchema,
    webBotAuth: CheckResultSchema,
  }),
  discovery: z.object({
    apiCatalog: CheckResultSchema,
    oauthDiscovery: CheckResultSchema,
    oauthProtectedResource: CheckResultSchema,
    mcpServerCard: CheckResultSchema,
    a2aAgentCard: CheckResultSchema,
    agentSkills: CheckResultSchema,
    webMcp: CheckResultSchema,
  }),
  commerce: z.object({
    x402: CheckResultSchema,
    mpp: CheckResultSchema,
    ucp: CheckResultSchema,
    acp: CheckResultSchema,
    ap2: CheckResultSchema,
  }),
});
export type ChecksBlock = z.infer<typeof ChecksBlockSchema>;

// ---------------------------------------------------------------------------
// Next-level requirements
// ---------------------------------------------------------------------------

export const NextLevelRequirementSchema = z.object({
  check: CheckIdSchema,
  description: z.string(),
  shortPrompt: z.string(),
  prompt: z.string(),
  specUrls: z.array(z.string()),
  skillUrl: z.string().optional(), // ap2 has no skill
});
export type NextLevelRequirement = z.infer<typeof NextLevelRequirementSchema>;

export const NextLevelSchema = z.object({
  target: z.number().int().min(1).max(5),
  name: LevelNameSchema,
  requirements: z.array(NextLevelRequirementSchema),
});
export type NextLevel = z.infer<typeof NextLevelSchema>;

// ---------------------------------------------------------------------------
// Top-level scan response
// ---------------------------------------------------------------------------

export const ScanResponseSchema = z.object({
  url: z.string(),
  scannedAt: z.string(), // ISO-8601
  level: LevelSchema,
  levelName: LevelNameSchema,
  checks: ChecksBlockSchema,
  nextLevel: NextLevelSchema.nullable(),
  isCommerce: z.boolean(),
  commerceSignals: z.array(z.string()),
});
export type ScanResponse = z.infer<typeof ScanResponseSchema>;

// ---------------------------------------------------------------------------
// POST /api/scan request
// ---------------------------------------------------------------------------

export const ScanRequestSchema = z.object({
  url: z.string().url().max(2048),
  profile: ProfileSchema.optional(),
  // There are 19 canonical check ids; cap at 19 so an attacker can't ship
  // a megabyte-long check list that the scheduler then iterates over.
  enabledChecks: z.array(CheckIdSchema).max(19).optional(),
  format: z.literal("agent").optional(),
});
export type ScanRequest = z.infer<typeof ScanRequestSchema>;
