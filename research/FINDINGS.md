# isitagentready.com — Research Findings

**Source:** https://isitagentready.com/ (Cloudflare)
**Research date:** 2026-04-23
**Raw artifacts:** `research/raw/` (5 scan JSONs + 1 agent-format markdown) and `research/skills/` (17 SKILL.md files)

---

## 1. Product summary

A "Lighthouse for AI agents" scanner. Single-page app that takes a URL, runs 19 standards checks across 5 categories against that URL's origin, and returns:

- An overall score 0–100
- A readiness **level** 0–5 with a level name
- Per-check pass / fail / neutral status with full request/response evidence
- For each failing check: goal, issue, how-to-implement text, reference links, and a copy-paste-ready "fix prompt" for coding agents
- Also exposes the same scanner via an MCP server (stateless Streamable HTTP) and an API endpoint for programmatic use

Not monetized. No auth. No pricing. Static + serverless.

---

## 2. URL routing

| Path | Purpose |
|---|---|
| `/` | Homepage (scan form) |
| `/{hostname}` | Results page — deep-linkable, path-encoded origin (e.g. `/developers.cloudflare.com`) |
| `/api/scan` | POST JSON scan endpoint |
| `/mcp` | POST-only Stateless Streamable HTTP MCP server |
| `/robots.txt`, `/sitemap.xml`, `/llms.txt` | Standard discovery files (the site eats its own dog food) |
| `/.well-known/agent-skills/index.json` | Its own skill discovery index (22 skills) |
| `/.well-known/agent-skills/{slug}/SKILL.md` | Implementation guides — also hot-linked from fail-state UI and from the agent-format API output |

---

## 3. The 19 checks

Internal check identifiers are camelCase; categories use the exact labels below in the UI.

### Category: Discoverability
| key | display | default | spec |
|---|---|---|---|
| `robotsTxt` | robots.txt | ✓ | RFC 9309 |
| `sitemap` | Sitemap | ✓ | sitemaps.org |
| `linkHeaders` | Link headers | ✓ | RFC 8288, RFC 9727 §3 |

### Category: Content Accessibility (UI label) / `contentAccessibility` (API key)
| key | display | default | spec |
|---|---|---|---|
| `markdownNegotiation` | Markdown Negotiation | ✓ | Markdown for Agents, llmstxt.org |

### Category: Bot Access Control / `botAccessControl`
| key | display | default | spec |
|---|---|---|---|
| `robotsTxtAiRules` | AI bot rules in robots.txt | ✓ | RFC 9309 |
| `contentSignals` | Content Signals in robots.txt | ✓ | contentsignals.org, IETF draft-romm-aipref-contentsignals |
| `webBotAuth` | Web Bot Auth | ✓ (neutral unless present) | IETF WebBotAuth WG |

### Category: API / Auth / MCP (UI) = "API, Auth, MCP & Skill Discovery" (results card) = `discovery` (API)
| key | display | default | spec |
|---|---|---|---|
| `apiCatalog` | API Catalog | ✓ | RFC 9727 |
| `oauthDiscovery` | OAuth / OIDC discovery | ✓ | RFC 8414, OIDC Discovery 1.0 |
| `oauthProtectedResource` | OAuth Protected Resource | ✓ | RFC 9728 |
| `mcpServerCard` | MCP Server Card | ✓ | SEP-1649 / MCP PR #2127 |
| `a2aAgentCard` | A2A Agent Card | **✗** (opt-in) | a2a-protocol.org |
| `agentSkills` | Agent Skills | ✓ | agentskills.io discovery RFC v0.2.0 |
| `webMcp` | WebMCP | ✓ | webmachinelearning.github.io/webmcp |

### Category: Commerce / `commerce` (shown only if commerce signals detected OR if Site Type ≠ "Content Site")
| key | display | default | spec |
|---|---|---|---|
| `x402` | x402 Protocol | ✓ | x402.org |
| `mpp` | MPP (Machine Payment Protocol) | ✓ | mpp.dev, paymentauth.org draft |
| `ucp` | Universal Commerce Protocol | ✓ | ucp.dev |
| `acp` | ACP (Agentic Commerce Protocol) | ✓ | agenticcommerce.dev |
| `ap2` | AP2 | — | (no public SKILL.md — returns 404; derived from A2A Agent Card presence) |

**Total: 19 checks** — matches the MCP tool description and the `enabledChecks` enum exactly.

---

## 4. API contract — `POST /api/scan`

### Request
```json
{
  "url": "https://example.com",
  "profile": "all" | "content" | "apiApp",
  "enabledChecks": ["robotsTxt", "sitemap", ...],
  "format": "agent" // optional — returns plain markdown fix prompt instead of JSON
}
```

- `url` required. Origin-only (subpaths accepted but checks target well-known paths on the origin).
- `profile` presets: `all` (default), `content` (skip discovery/commerce), `apiApp` (all except commerce).
- `enabledChecks` explicit list, overrides `profile`.
- `format: "agent"` returns a plain-text markdown fix prompt (see §6).

### Default JSON response (observed, all fields present)
```ts
{
  url: string,                  // echo
  scannedAt: string,            // ISO-8601
  level: 0 | 1 | 2 | 3 | 4 | 5,
  levelName: "Not Ready" | "Basic Web Presence" | "Bot-Aware"
           | "Agent-Readable" | "Agent-Integrated" | "Agent-Native",
  checks: {
    discoverability:    { robotsTxt, sitemap, linkHeaders },
    contentAccessibility: { markdownNegotiation },
    botAccessControl:   { robotsTxtAiRules, contentSignals, webBotAuth },
    discovery:          { apiCatalog, oauthDiscovery, oauthProtectedResource,
                          mcpServerCard, a2aAgentCard, agentSkills, webMcp },
    commerce:           { x402, mpp, ucp, acp, ap2 }
  },
  nextLevel: {
    target: number,             // level + 1
    name: string,                // level name
    requirements: Array<{
      check: string,             // e.g. "robotsTxt"
      description: string,       // short goal sentence
      shortPrompt: string,
      prompt: string,            // long, prescriptive — for coding agents
      specUrls: string[],
      skillUrl: string           // https://isitagentready.com/.well-known/agent-skills/{slug}/SKILL.md
    }>
  } | null,
  isCommerce: boolean,
  commerceSignals: string[]     // e.g. ["platform:shopify", "meta:shopify", "url:/checkout"]
}
```

### Per-check result object
```ts
{
  status: "pass" | "fail" | "neutral",
  message: string,               // summary
  details?: object,               // check-specific structured data (e.g. signals, grantTypes, issuer, platform)
  evidence: Array<{
    action: "fetch" | "conclude" | "parse" | "validate" | "navigate" | ...,
    label: string,               // e.g. "GET /robots.txt"
    request?:  { url, method, headers? },
    response?: { status, statusText, headers },
    finding:  {
      outcome: "positive" | "negative" | "neutral",
      summary: string
    },
    body?: string                // truncated preview of response body (robots.txt contents, etc.)
  }>,
  durationMs: number
}
```

---

## 5. Scoring & level algorithm (reverse-engineered)

### Overall score
`score = round(passes / denominator × 100)` where:

- **denominator = count of `pass` + `fail` checks** that are actually scored
- Excluded from denominator:
  - `commerce` category entirely when `isCommerce === false`
  - Checks with `status === "neutral"` (most commonly `webBotAuth`)
  - Checks the user opted out of (`a2aAgentCard` is off by default)

Verified against `developers.cloudflare.com` scan: UI showed 58/100 with breakdown 3/3, 1/1, 2/2, 1/6 → 7/12 = 58.3 % ✓.

### Per-category score (UI circle)
`categoryScore = round(passes / (passes+fails) × 100)` per category, or "N/A" when commerce excluded.

### Level thresholds (ladder based on required-check sets, inferred from nextLevel data)
| Level | Name | Required checks (best inference) |
|---|---|---|
| 0 | Not Ready | baseline |
| 1 | Basic Web Presence | `robotsTxt`, `sitemap` |
| 2 | Bot-Aware | L1 + `robotsTxtAiRules`, `contentSignals` |
| 3 | Agent-Readable | L2 + `markdownNegotiation` |
| 4 | Agent-Integrated | L3 + `linkHeaders`, `agentSkills` |
| 5 | Agent-Native | L4 + `apiCatalog`, `oauthProtectedResource`, `mcpServerCard`, `a2aAgentCard` (commerce not required) |

The `nextLevel.requirements` array returned by the API is authoritative for UI purposes — it's the list of currently-failing required checks for the next rung.

---

## 6. "Agent format" output (`format: "agent"`)

Returns `Content-Type: text/markdown`. Shape:

```markdown
# Site Analysis: {url}

Score: {level}/5 ({levelName})

The following issues were found. Fix them to improve your agent-readiness score:

## {requirement.description}
{requirement.shortPrompt or prompt}
Implementation guide: {requirement.skillUrl}

## {next requirement...}
```

One H2 per **failing-and-in-scope** check; concludes with no footer. Intended for pasting directly into a coding agent.

---

## 7. MCP server (`/mcp`)

- **Endpoint:** `https://isitagentready.com/mcp`
- **Method:** POST only. Returns 405 on GET with JSON-RPC envelope error.
- **Transport:** Streamable HTTP, stateless, `Accept: text/event-stream` or `application/json`.
- **serverInfo:** `{ name: "Agent Readiness Scanner", version: "1.0.0" }`
- **Capabilities:** `tools.listChanged: true`
- **Tools:** 1 tool — `scan_site` with inputSchema matching `/api/scan` (url/profile/enabledChecks). Execution mode: `taskSupport: "forbidden"` (synchronous only).

---

## 8. UI structure

### 8.1 Homepage (`/`)
- Header: Cloudflare logo + title wordmark, right-side "Learn more about Agents" link, theme toggle (System/Light/Dark).
- H1 "Is Your Site Agent-Ready?"
- Intro paragraph with inline links to Markdown negotiation, MCP, Agent Skills.
- **Scan form:** URL input (placeholder `https://example.com`) + orange "Scan" button.
- **"Customize scan" disclosure** (closed by default) — opens a panel with:
  - Site Type radio group: "All Checks" (default) · "Content Site" · "API / Application"
  - Five check groups (Discoverability, Content Accessibility, Bot Access Control, API / Auth / MCP, Commerce) as checkbox lists; A2A Agent Card unchecked by default; commerce group hidden in Content Site profile.
- Three collapsible info cards: "What do we check?", "What's the easiest way to improve my score?", "Where can I learn more?"
- Disclaimer line: "These are AI-generated recommendations..."
- Footer: © 2026 Cloudflare, Inc. | Privacy Policy | Terms of Use | Docs

### 8.2 Results page (`/{hostname}`)
Rendered in-place after scan (or on direct load). Structure:

- Same header/scan form at top (with input prefilled, showing "Last scanned {date} at {time}")
- **Score card**:
  - "Share score card" button (top-right, copies/share result URL)
  - "Results for {url}"
  - Large animated arc gauge showing overall score (0–100)
  - Level pill: "Level {N}" + level name
  - **Category mini-cards** (4 or 5): each shows a circular gauge with category percentage (or "N/A"), category name, `{passes}/{total}` fraction
- **"Improve the score" CTA** — orange button with badge showing count of failing checks
- **Per-category sections**, each with:
  - H2 category name + `{passes}/{total}` badge (or "Optional" for Commerce when not applicable)
  - Commerce section shows descriptive note when not applicable: "No e-commerce signals were detected on this site. These checks are shown for informational purposes and do not affect the score."
  - Per-check collapsible row. Collapsed state: status icon (✓ green pass, ✗ red fail, ⚪ neutral/"Not applicable"), check display name. Expanded state differs by status:
    - **Pass:** shows evidence timeline (each evidence step: action icon, label, status code, request/response header table, body preview, finding summary) + "Completed in {N}ms" + "Back to results" button.
    - **Fail:** shows two-panel content:
      - Left panel ("overview"): `Goal` term/def, `Issue` term/def, "How to implement" paragraph, "Resources" with spec links + "Skill" link (→ SKILL.md), footer with "Copy prompt" (copies `requirement.prompt`) and "View audit details" button.
      - Right panel ("audit"): same evidence timeline as Pass, shown when "Audit details" is toggled. "Back" button returns to overview.
    - **Neutral / Not applicable:** same as Pass (evidence only), just styled grey.
- "Scan another site" button at the bottom, clears form + returns to `/`.

### 8.3 Visual design
- **Palette:** Cloudflare orange (#F6821F for primary button/accents), white bg, very dark brown/near-black text; warm off-white cards (#FDF6EE-ish). Fail red, pass green.
- **Typography:** System sans (SF Pro / Segoe / Inter-ish). Heading is bold, serif-adjacent — actually appears to be a geometric sans at semi-bold weight.
- **Layout:** Centered single-column, max-width ~640–720px. Card pattern with pill shapes + subtle outlined borders.
- **Theme toggle:** three-state (System / Light / Dark), stored in local state; auto-detects `prefers-color-scheme`.

---

## 9. Check implementation detail — fetch plan per check

Derived from the evidence arrays in raw scan responses.

| Check | Requests made | Pass criterion |
|---|---|---|
| `robotsTxt` | `GET /robots.txt` | 200 + `text/plain` + no soft-404 + contains valid `User-agent` directive |
| `sitemap` | `GET /sitemap-index.xml`, `/sitemap.xml.gz`, `/sitemap_index.xml`, `/sitemap.xml` (in order); also parses `Sitemap:` directive from robots.txt first | Any returns 200 with valid XML |
| `linkHeaders` | `GET /` (homepage) | Response has `Link:` header with registered relations (`api-catalog`, `service-desc`, `service-doc`, `describedby`, etc.) |
| `markdownNegotiation` | `GET /` with `Accept: text/markdown` | Response `Content-Type` starts with `text/markdown` |
| `robotsTxtAiRules` | Re-uses `/robots.txt` body | Has AI-bot-named User-agent block OR wildcard covers AI bots. Scans ~15 AI bot UAs (GPTBot, ClaudeBot, Google-Extended, PerplexityBot, CCBot, etc.). |
| `contentSignals` | Re-uses `/robots.txt` body | At least one `Content-Signal:` directive present |
| `webBotAuth` | `GET /.well-known/http-message-signatures-directory` | Valid JWKS returned → pass; otherwise neutral (informational) |
| `apiCatalog` | `GET /.well-known/api-catalog` with `Accept: application/linkset+json, application/json` | 200 + `application/linkset+json` + linkset array non-empty |
| `oauthDiscovery` | `GET /.well-known/openid-configuration` and `/.well-known/oauth-authorization-server` | Either returns 200 JSON with `issuer`, `authorization_endpoint`, `token_endpoint`, `jwks_uri` |
| `oauthProtectedResource` | `GET /` (for `WWW-Authenticate`) + `GET /.well-known/oauth-protected-resource` | 200 JSON with `resource` + `authorization_servers` |
| `mcpServerCard` | `GET /.well-known/mcp/server-card.json`, `/.well-known/mcp/server-cards.json`, `/.well-known/mcp.json` | Any 200 JSON with `serverInfo`, transport endpoint |
| `a2aAgentCard` | `GET /.well-known/agent-card.json` | 200 JSON with `name`, `version`, `supportedInterfaces` |
| `agentSkills` | `GET /.well-known/agent-skills/index.json` | 200 JSON with `$schema` = `https://schemas.agentskills.io/discovery/0.2.0/schema.json` and `skills[]` array |
| `webMcp` | Headless-browser page load, detect `navigator.modelContext` calls | Any tool registered via `registerTool()` or `provideContext()` |
| `x402` | `GET /`, `GET /api`, `GET /api/v1`, and lookup in `https://www.x402.org/platform/v2/x402/discovery/resources` bazaar API | Any response returns 402 with x402 payment requirements |
| `mpp` | `GET /openapi.json` | 200 JSON with `x-payment-info` extensions |
| `ucp` | `GET /.well-known/ucp` | 200 JSON with `protocol_version`, `services`, `capabilities`, `endpoints` |
| `acp` | `GET /.well-known/acp.json` | 200 JSON with `protocol.name == "acp"`, `api_base_url`, non-empty `transports`, `capabilities.services` |
| `ap2` | Re-uses a2a-agent-card result | Pass iff a2aAgentCard passes with AP2-compatible capability |

**Commerce site detection** (drives `isCommerce` + category visibility):
- Scans homepage HTML for platform signals: meta tags (`shopify`, `woocommerce`, `magento`), `Set-Cookie` patterns, script URLs, common URL paths (`/checkout`, `/product`, `/shop`, `/cart`).
- Returns `commerceSignals` array of matched patterns (e.g. `["platform:shopify", "meta:shopify", "url:/checkout"]`).

---

## 10. Fix-prompt text (`prompt` field) — example

From `example.com` nextLevel requirements (unmodified, for verbatim reuse):

> **robotsTxt:** "Create /robots.txt at the site root with explicit User-agent directives and allow/disallow rules for key paths. Ensure it is plain text and returns 200."
>
> **sitemap:** "Generate /sitemap.xml listing canonical URLs, keep it updated on publish, and reference it from /robots.txt."
>
> **linkHeaders:** "Add Link response headers to your homepage that point agents to useful resources. For example: `Link: </.well-known/api-catalog>; rel=\"api-catalog\"` to advertise your API catalog, or `Link: </docs/api>; rel=\"service-doc\"` for API documentation. See RFC 8288 for the Link header format and IANA Link Relations for registered relation types."

Prompts are stored per-check in a prompt dictionary; `shortPrompt` is the 1-sentence summary, `prompt` is the full actionable version used by "Copy prompt" and `format=agent` output.

---

## 11. AI-generated recommendations (disclaimer)

The page explicitly calls out: "These are AI-generated recommendations. AI can make mistakes." In practice the prompts appear hand-authored and static (not LLM-generated at runtime) — the fix prompts for a given check are deterministic across scans. The disclaimer covers the fact that these are heuristics, not audited legal/technical advice.

---

## 12. Non-goals observed

- No authentication, accounts, or persistence (no saved history)
- No rate limiting visible (scans just queue through Cloudflare)
- No comparison/versioning between scans
- No HTML embed / badge
- Very minimal SEO (single sitemap URL, no blog)
- No analytics visible in the UI; CF likely tracks server-side

---

## 13. Gaps / assumptions for replica

1. Exact level-threshold rules are inferred. `nextLevel.requirements` data is authoritative but the overall level-assignment function isn't published. For the replica we'll codify the table in §5 and let it round-trip-match the observed fixtures.
2. `webMcp` detection requires headless browser. Options: Playwright in a serverless function, Vercel Sandbox, or a lighter-weight static-HTML regex fallback that's honest about the trade-off.
3. Commerce detection heuristic pattern list isn't documented — we'll start with the observed signals (platform:*, meta:*, url:/checkout, url:/product, url:/shop, url:/cart) and extend.
4. A2A Agent Card is unchecked by default in the UI but reported in API responses as `fail` — we'll mirror this (do the check regardless; just exclude from default scoring denominator).
5. The AP2 check has no published SKILL.md. We'll derive its pass/fail from a2aAgentCard and skip generating a dedicated prompt.

---

**This document is the source-of-truth input to the build plan that follows in a separate turn.**
