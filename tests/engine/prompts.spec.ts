/**
 * Specs for `lib/engine/prompts.ts` — static catalog + agent report helper.
 */

import { describe, expect, it } from "vitest";

import {
  PROMPTS,
  getPromptFor,
  getRequirement,
  getAgentReport,
} from "@/lib/engine/prompts";
import type { CheckId } from "@/lib/schema";

const ALL_IDS: readonly CheckId[] = [
  "robotsTxt",
  "sitemap",
  "linkHeaders",
  "markdownNegotiation",
  "robotsTxtAiRules",
  "contentSignals",
  "webBotAuth",
  "apiCatalog",
  "oauthDiscovery",
  "oauthProtectedResource",
  "mcpServerCard",
  "a2aAgentCard",
  "agentSkills",
  "webMcp",
  "x402",
  "mpp",
  "ucp",
  "acp",
  "ap2",
];

describe("PROMPTS catalog", () => {
  it("has an entry for every check id", () => {
    for (const id of ALL_IDS) {
      expect(PROMPTS[id]).toBeDefined();
      expect(PROMPTS[id].description.length).toBeGreaterThan(0);
      expect(PROMPTS[id].prompt.length).toBeGreaterThan(0);
      expect(PROMPTS[id].shortPrompt.length).toBeGreaterThan(0);
      expect(Array.isArray(PROMPTS[id].specUrls)).toBe(true);
    }
  });

  it("getPromptFor returns the check's prompt", () => {
    expect(getPromptFor("robotsTxt")).toBe(PROMPTS.robotsTxt.prompt);
  });

  it("getRequirement returns a {check, ...entry} shape", () => {
    const req = getRequirement("sitemap");
    expect(req.check).toBe("sitemap");
    expect(req.description).toBe(PROMPTS.sitemap.description);
    expect(req.prompt).toBe(PROMPTS.sitemap.prompt);
  });
});

describe("getAgentReport", () => {
  const baseCheck = {
    status: "pass" as const,
    message: "ok",
  };
  const failCheck = {
    status: "fail" as const,
    message: "missing /robots.txt",
  };

  it("renders a markdown report with level, failing checks, and next-level", () => {
    const report = getAgentReport({
      url: "https://example.com",
      level: 1,
      levelName: "Basic Web Presence",
      isCommerce: false,
      checks: {
        discoverability: {
          robotsTxt: failCheck,
          sitemap: baseCheck,
          linkHeaders: baseCheck,
        },
      },
      nextLevel: {
        target: 2,
        name: "Bot-Aware",
        requirements: [getRequirement("robotsTxtAiRules")],
      },
    });
    expect(report).toMatch(/Agent Readiness Report/);
    expect(report).toMatch(/Level 1: Basic Web Presence/);
    expect(report).toMatch(/robotsTxt.*missing/);
    expect(report).toMatch(/Next step: reach Level 2 \(Bot-Aware\)/);
    expect(report).toMatch(/robotsTxtAiRules/);
  });

  it("indicates 'No failing checks' when none fail", () => {
    const report = getAgentReport({
      url: "https://example.com",
      level: 5,
      levelName: "Agent-Native",
      isCommerce: false,
      checks: {
        discoverability: { robotsTxt: baseCheck },
      },
      nextLevel: null,
    });
    expect(report).toMatch(/No failing checks/);
    expect(report).toMatch(/Level 5 reached/);
  });

  it("emits commerce indicator correctly", () => {
    const report = getAgentReport({
      url: "https://shop.test",
      level: 0,
      levelName: "Not Ready",
      isCommerce: true,
      checks: {},
      nextLevel: null,
    });
    expect(report).toMatch(/commerce site: yes/);
  });

  it("includes specUrls and skillUrl when present", () => {
    const report = getAgentReport({
      url: "https://example.com",
      level: 0,
      levelName: "Not Ready",
      isCommerce: false,
      checks: {},
      nextLevel: {
        target: 1,
        name: "Basic Web Presence",
        requirements: [getRequirement("robotsTxt"), getRequirement("ap2")],
      },
    });
    expect(report).toMatch(/Specs: https:\/\/www\.rfc-editor\.org\/rfc\/rfc9309/);
    expect(report).toMatch(/Skill: .*robots-txt\/SKILL\.md/);
  });
});
