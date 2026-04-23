/**
 * Static catalog of "how to fix" prompts + next-level requirement metadata.
 *
 * Source: reference scanner's nextLevel.requirements payloads captured in
 * `research/raw/*.json`. When we don't have a captured entry for a given
 * check, we author a concise actionable prompt that mirrors the captured
 * voice (imperative + spec URL(s) + skillUrl when available).
 */

import type { CheckId, NextLevelRequirement } from "@/lib/schema";

// ---------------------------------------------------------------------------
// Prompt catalog
// ---------------------------------------------------------------------------

type PromptEntry = Omit<NextLevelRequirement, "check">;

const SKILL_BASE = "https://isitagentready.com/.well-known/agent-skills";

export const PROMPTS: Readonly<Record<CheckId, PromptEntry>> = {
  robotsTxt: {
    description: "Publish /robots.txt with clear crawl rules",
    shortPrompt:
      "Create /robots.txt at the site root with explicit User-agent directives and allow/disallow rules for key paths.",
    prompt:
      "Create /robots.txt at the site root with explicit User-agent directives and allow/disallow rules for key paths. Ensure it is plain text and returns 200.",
    specUrls: ["https://www.rfc-editor.org/rfc/rfc9309"],
    skillUrl: `${SKILL_BASE}/robots-txt/SKILL.md`,
  },
  sitemap: {
    description: "Publish a sitemap and reference it from robots.txt",
    shortPrompt:
      "Generate /sitemap.xml listing canonical URLs, keep it updated on publish, and reference it from /robots.txt.",
    prompt:
      "Generate /sitemap.xml listing canonical URLs, keep it updated on publish, and reference it from /robots.txt.",
    specUrls: ["https://www.sitemaps.org/protocol.html"],
    skillUrl: `${SKILL_BASE}/sitemap/SKILL.md`,
  },
  linkHeaders: {
    description:
      "Include Link response headers for agent discovery (RFC 8288)",
    shortPrompt:
      "Add Link response headers to your homepage pointing to API docs, catalogs, or machine-readable descriptions.",
    prompt:
      'Add Link response headers to your homepage that point agents to useful resources. For example: Link: </.well-known/api-catalog>; rel="api-catalog" to advertise your API catalog, or Link: </docs/api>; rel="service-doc" for API documentation. See RFC 8288 for the Link header format and IANA Link Relations for registered relation types.',
    specUrls: [
      "https://www.rfc-editor.org/rfc/rfc8288",
      "https://www.rfc-editor.org/rfc/rfc9727#section-3",
    ],
    skillUrl: `${SKILL_BASE}/link-headers/SKILL.md`,
  },
  markdownNegotiation: {
    description:
      "Support Accept: text/markdown content negotiation for machine-readable content",
    shortPrompt:
      "Enable Markdown for Agents so requests with Accept: text/markdown return a markdown version of your HTML.",
    prompt:
      "Implement content negotiation so requests with Accept: text/markdown return a markdown representation while HTML remains the default for browsers.",
    specUrls: [
      "https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/",
    ],
    skillUrl: `${SKILL_BASE}/markdown-negotiation/SKILL.md`,
  },
  robotsTxtAiRules: {
    description:
      "Add AI-bot-aware rules to /robots.txt (GPTBot, ClaudeBot, PerplexityBot, etc.)",
    shortPrompt:
      "Add explicit Allow/Disallow rules for named AI user-agents (GPTBot, ClaudeBot, PerplexityBot, etc.) in /robots.txt.",
    prompt:
      "Extend /robots.txt with User-agent sections for the common AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Applebot-Extended, Google-Extended) declaring your intent. Omit a group for unknown agents or fall back to User-agent: * — whichever matches your policy.",
    specUrls: [
      "https://platform.openai.com/docs/gptbot",
      "https://docs.claude.com/en/docs/claude-code/web-crawler",
    ],
    skillUrl: `${SKILL_BASE}/robots-txt-ai-rules/SKILL.md`,
  },
  contentSignals: {
    description:
      "Declare AI content usage preferences with Content Signals in robots.txt",
    shortPrompt:
      "Add Content-Signal directives to your robots.txt declaring preferences for ai-train, search, and ai-input.",
    prompt:
      "Add Content-Signal directives to your robots.txt declaring preferences for ai-train, search, and ai-input. For example:\nContent-Signal: ai-train=no, search=yes, ai-input=no",
    specUrls: [
      "https://contentsignals.org/",
      "https://datatracker.ietf.org/doc/draft-romm-aipref-contentsignals/",
    ],
    skillUrl: `${SKILL_BASE}/content-signals/SKILL.md`,
  },
  webBotAuth: {
    description: "Authenticate your crawler / agent traffic with Web Bot Auth",
    shortPrompt:
      "Adopt Web Bot Auth signatures so origins can verify requests coming from your agent.",
    prompt:
      "Advertise a Web Bot Auth key at /.well-known/http-message-signatures-directory and sign outbound requests with Ed25519 signatures per draft-ietf-httpbis-http-message-signatures.",
    specUrls: [
      "https://datatracker.ietf.org/doc/draft-meunier-web-bot-auth/",
      "https://datatracker.ietf.org/doc/rfc9421/",
    ],
    skillUrl: `${SKILL_BASE}/web-bot-auth/SKILL.md`,
  },
  apiCatalog: {
    description: "Publish an API catalog for automated API discovery (RFC 9727)",
    shortPrompt:
      'Create /.well-known/api-catalog returning application/linkset+json with a "linkset" array listing your APIs and their specs.',
    prompt:
      'Create /.well-known/api-catalog returning application/linkset+json with a "linkset" array. Each entry should include an "anchor" URL for the API and link relations for service-desc (OpenAPI spec), service-doc (documentation), and status (health endpoint). See RFC 9727 Appendix A for examples.',
    specUrls: [
      "https://www.rfc-editor.org/rfc/rfc9727",
      "https://www.rfc-editor.org/rfc/rfc9264",
    ],
    skillUrl: `${SKILL_BASE}/api-catalog/SKILL.md`,
  },
  oauthDiscovery: {
    description: "Publish OAuth 2.0 Authorization Server Metadata (RFC 8414)",
    shortPrompt:
      "Serve /.well-known/oauth-authorization-server with issuer, authorization_endpoint, token_endpoint, and supported grants.",
    prompt:
      "Publish OAuth 2.0 Authorization Server Metadata at /.well-known/oauth-authorization-server per RFC 8414 so agents can discover your authorization + token endpoints and supported grant types. Include issuer, authorization_endpoint, token_endpoint, jwks_uri, scopes_supported, and response_types_supported.",
    specUrls: ["https://www.rfc-editor.org/rfc/rfc8414"],
    skillUrl: `${SKILL_BASE}/oauth-discovery/SKILL.md`,
  },
  oauthProtectedResource: {
    description:
      "Publish OAuth Protected Resource Metadata so agents can discover how to authenticate",
    shortPrompt:
      "Publish /.well-known/oauth-protected-resource with your resource identifier and authorization_servers so agents can discover how to authenticate.",
    prompt:
      "Publish /.well-known/oauth-protected-resource with your resource identifier, authorization_servers (list of OAuth/OIDC issuer URLs that can issue tokens for this resource), and scopes_supported. This tells agents how to obtain access tokens for your protected APIs. You can also return a WWW-Authenticate header with a resource_metadata parameter on 401 responses to enable dynamic discovery.",
    specUrls: ["https://www.rfc-editor.org/rfc/rfc9728"],
    skillUrl: `${SKILL_BASE}/oauth-protected-resource/SKILL.md`,
  },
  mcpServerCard: {
    description: "Publish an MCP Server Card for agent discovery",
    shortPrompt:
      "Serve an MCP Server Card (SEP-1649) at /.well-known/mcp/server-card.json with serverInfo, transport endpoint, and capabilities.",
    prompt:
      "Serve an MCP Server Card (SEP-1649) at /.well-known/mcp/server-card.json with serverInfo (name, version), transport endpoint, and capabilities. The schema is being standardized at https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2127",
    specUrls: [
      "https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2127",
    ],
    skillUrl: `${SKILL_BASE}/mcp-server-card/SKILL.md`,
  },
  a2aAgentCard: {
    description: "Publish an A2A Agent Card for agent-to-agent discovery",
    shortPrompt:
      "Serve an A2A Agent Card at /.well-known/agent-card.json with your agent name, version, supported interfaces, capabilities, and skills.",
    prompt:
      "Serve an A2A Agent Card (JSON) at /.well-known/agent-card.json describing your agent. Include name, version, description, supportedInterfaces (with service URL and transport protocol), capabilities, and skills (each with id, name, description). This enables other AI agents to discover and interact with your agent via the A2A protocol.",
    specUrls: [
      "https://a2a-protocol.org/latest/specification/",
      "https://a2a-protocol.org/latest/topics/agent-discovery/",
    ],
    skillUrl: `${SKILL_BASE}/a2a-agent-card/SKILL.md`,
  },
  agentSkills: {
    description:
      "Publish an Agent Skills index so agents can discover reusable skill packs",
    shortPrompt:
      "Serve /.well-known/agent-skills/index.json listing each skill with id, name, description, and SKILL.md URL.",
    prompt:
      'Publish an Agent Skills index at /.well-known/agent-skills/index.json. Each entry should be a { id, name, description, url } object pointing at a SKILL.md file that describes the skill in natural language.',
    specUrls: [
      "https://docs.anthropic.com/en/docs/agents-and-tools/agent-skills/overview",
    ],
    skillUrl: `${SKILL_BASE}/agent-skills/SKILL.md`,
  },
  webMcp: {
    description: "Advertise a WebMCP endpoint from the homepage",
    shortPrompt:
      'Expose a WebMCP handshake so browsers and agents can connect to your MCP server inline.',
    prompt:
      "Announce a WebMCP endpoint in the homepage HTML (link/meta tag or inline script) so in-browser agents can attach to your MCP server without out-of-band configuration.",
    specUrls: ["https://modelcontextprotocol.io/specification/"],
    skillUrl: `${SKILL_BASE}/web-mcp/SKILL.md`,
  },
  x402: {
    description: "Return HTTP 402 with x402 payment requirements",
    shortPrompt:
      "Respond to paid API requests with HTTP 402 and an x402 payment requirements document.",
    prompt:
      'Return HTTP 402 with an x402 payment requirements document ({ x402Version, accepts: [...] }) from paid endpoints. See https://www.x402.org/ for the full schema and SDK list.',
    specUrls: ["https://www.x402.org/"],
    skillUrl: `${SKILL_BASE}/x402/SKILL.md`,
  },
  mpp: {
    description: "Advertise a machine payment profile in your OpenAPI spec",
    shortPrompt:
      'Add x-payment-info extensions to your /openapi.json describing how machines can pay for operations.',
    prompt:
      "Serve /openapi.json and annotate paid operations with the x-payment-info extension so agents can plan billable requests.",
    specUrls: ["https://mpp.dev/"],
    skillUrl: `${SKILL_BASE}/mpp/SKILL.md`,
  },
  ucp: {
    description: "Publish a UCP (Universal Commerce Protocol) profile",
    shortPrompt:
      "Serve /.well-known/ucp with protocol_version, services, capabilities, and endpoints.",
    prompt:
      'Publish a UCP profile at /.well-known/ucp with JSON: { protocol_version, services, capabilities, endpoints }. See https://ucp.dev/ for the current schema.',
    specUrls: ["https://ucp.dev/"],
    skillUrl: `${SKILL_BASE}/ucp/SKILL.md`,
  },
  acp: {
    description: "Publish an ACP discovery document",
    shortPrompt:
      "Serve /.well-known/acp.json declaring your agent commerce capabilities.",
    prompt:
      "Publish an ACP discovery document at /.well-known/acp.json describing your agent commerce capabilities (supported flows, endpoints, authentication).",
    specUrls: ["https://agentcommerce.org/"],
    skillUrl: `${SKILL_BASE}/acp/SKILL.md`,
  },
  ap2: {
    description:
      "Declare an AP2 (Agent Payments Protocol) skill on your A2A Agent Card",
    shortPrompt:
      'Publish an A2A Agent Card that advertises an AP2-compatible skill (id or name containing "ap2", "payment", or "checkout").',
    prompt:
      "Publish an A2A Agent Card at /.well-known/agent-card.json that advertises an AP2-compatible skill. AP2 has no dedicated discovery document — its presence is inferred from a passing A2A Agent Card that declares a payments-related skill.",
    specUrls: ["https://ap2-protocol.org/"],
  },
};

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

export function getPromptFor(checkId: CheckId): string {
  return PROMPTS[checkId].prompt;
}

export function getRequirement(checkId: CheckId): NextLevelRequirement {
  return { check: checkId, ...PROMPTS[checkId] };
}

/**
 * Generate a Markdown "agent report" for the `format: "agent"` response of
 * /api/scan. Produces a concise, actionable summary a downstream agent can
 * read to plan follow-up work.
 */
export function getAgentReport(payload: {
  readonly url: string;
  readonly level: number;
  readonly levelName: string;
  readonly nextLevel: {
    readonly target: number;
    readonly name: string;
    readonly requirements: readonly NextLevelRequirement[];
  } | null;
  readonly checks: Record<
    string,
    Record<string, { readonly status: string; readonly message: string }>
  >;
  readonly isCommerce: boolean;
}): string {
  const lines: string[] = [];
  lines.push(`# Agent Readiness Report for ${payload.url}`);
  lines.push("");
  lines.push(
    `**Level ${payload.level}: ${payload.levelName}** — commerce site: ${payload.isCommerce ? "yes" : "no"}`,
  );
  lines.push("");

  // Failing checks, grouped by category.
  lines.push("## Failing checks");
  lines.push("");
  let anyFail = false;
  for (const cat of Object.keys(payload.checks)) {
    const checks = payload.checks[cat];
    if (checks === undefined) continue;
    for (const cid of Object.keys(checks)) {
      const check = checks[cid];
      if (check === undefined) continue;
      if (check.status === "fail") {
        anyFail = true;
        lines.push(`- **${cid}** (${cat}): ${check.message}`);
      }
    }
  }
  if (!anyFail) lines.push("_No failing checks._");
  lines.push("");

  // Next-level recommendations.
  if (payload.nextLevel !== null) {
    lines.push(
      `## Next step: reach Level ${payload.nextLevel.target} (${payload.nextLevel.name})`,
    );
    lines.push("");
    for (const req of payload.nextLevel.requirements) {
      lines.push(`### ${req.check}`);
      lines.push("");
      lines.push(req.description);
      lines.push("");
      lines.push(req.prompt);
      lines.push("");
      if (req.specUrls.length > 0) {
        lines.push(`Specs: ${req.specUrls.join(", ")}`);
        lines.push("");
      }
      if (req.skillUrl !== undefined) {
        lines.push(`Skill: ${req.skillUrl}`);
        lines.push("");
      }
    }
  } else {
    lines.push("## Level 5 reached — no further recommendations.");
    lines.push("");
  }

  return lines.join("\n");
}
