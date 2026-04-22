# Implementation Plan — isitagentready replica on Vercel

**Status:** awaiting confirmation to begin Phase 0
**Last updated:** 2026-04-23
**Input document:** [research/FINDINGS.md](research/FINDINGS.md) — functional spec derived from live reverse-engineering of https://isitagentready.com/
**Reuse basis:** [PromptMention/isitagentready](https://github.com/PromptMention/isitagentready) (MIT) — port ~10 check implementations with attribution; not forked

---

## Goal

Build a faithful, full-functionality replica of Cloudflare's isitagentready.com: same 19 checks across 5 categories, same public API shape (`POST /api/scan`), same MCP server surface (`/mcp`), same visual/interaction model (score gauge, category cards, per-check accordion with overview + audit-details split). Deploy on Vercel.

Non-goals: accounts, persistence, analytics, SaaS layer, marketing site.

---

## Stack (final)

| Layer | Choice |
|---|---|
| Framework | **Next.js 16 App Router** on Vercel (Fluid Compute, Node 24) |
| Language | TypeScript, strict mode |
| Styling | **Tailwind CSS v4** + **shadcn/ui** primitives (Accordion, Checkbox, RadioGroup, Button) |
| Validation | **Zod** (schema-first — API request + engine results) |
| XML parsing | **fast-xml-parser** (sitemaps) |
| MCP server | **`@modelcontextprotocol/sdk`** with Streamable HTTP, stateless — mounted at `/mcp` route handler |
| Headless probes | **Regex/static fallback first** for `webMcp` (fetch HTML + search inline/linked JS for `navigator.modelContext`). Upgrade path = **Vercel Sandbox** for real Chromium eval. |
| HTTP | native `fetch` + `AbortSignal.timeout` (no axios) |
| State | URL state only. React Query for scan-in-flight. No persistence. |
| Testing | **Vitest** unit (driven by the 5 real scan fixtures in `research/raw/` as oracles) + **Playwright** E2E happy paths |
| Deploy | Single Vercel project, preview + prod. `vercel.ts` config. |

No database. No auth. No external LLM calls — the real site's "AI-generated recommendations" are deterministic per-check in practice; we'll ship them as a static catalog.

---

## Repo layout

```
.
├── research/                       # already present — FINDINGS.md + fixtures + skill catalog
├── app/
│   ├── layout.tsx
│   ├── page.tsx                    # /
│   ├── [hostname]/page.tsx         # /{hostname} — results page (server-rendered)
│   ├── api/scan/route.ts           # POST /api/scan
│   ├── mcp/route.ts                # POST /mcp — MCP Streamable HTTP
│   ├── .well-known/
│   │   ├── agent-skills/
│   │   │   ├── index.json/route.ts
│   │   │   └── [slug]/SKILL.md/route.ts
│   │   ├── mcp/server-card.json/route.ts   # dogfood → level 5 on our own scanner
│   │   └── oauth-protected-resource/route.ts
│   ├── robots.txt/route.ts          # includes Content-Signal directives
│   ├── sitemap.xml/route.ts
│   └── llms.txt/route.ts
├── lib/
│   ├── engine/
│   │   ├── index.ts                # orchestrator: runScan(url, opts)
│   │   ├── context.ts              # shared fetch, homepage probe, robots cache
│   │   ├── checks/
│   │   │   ├── robots-txt.ts
│   │   │   ├── sitemap.ts
│   │   │   ├── link-headers.ts
│   │   │   ├── markdown-negotiation.ts
│   │   │   ├── robots-ai-rules.ts
│   │   │   ├── content-signals.ts
│   │   │   ├── web-bot-auth.ts
│   │   │   ├── api-catalog.ts
│   │   │   ├── oauth-discovery.ts
│   │   │   ├── oauth-protected-resource.ts
│   │   │   ├── mcp-server-card.ts
│   │   │   ├── a2a-agent-card.ts
│   │   │   ├── agent-skills.ts
│   │   │   ├── web-mcp.ts
│   │   │   ├── x402.ts
│   │   │   ├── mpp.ts
│   │   │   ├── ucp.ts
│   │   │   ├── acp.ts
│   │   │   └── ap2.ts
│   │   ├── commerce-signals.ts     # isCommerce + commerceSignals[] heuristic
│   │   ├── scoring.ts              # passes / scored × 100 (excluding neutrals + commerce-when-not-commerce + opt-outs)
│   │   ├── levels.ts               # ladder table + nextLevel.requirements synth
│   │   └── prompts.ts              # static fix-prompt catalog keyed by check id
│   ├── skills/                     # mirror of research/skills/*.md (served at /.well-known/agent-skills/…)
│   └── schema.ts                   # Zod schemas matching Cloudflare's response shape exactly
├── components/
│   ├── ScanForm.tsx
│   ├── CustomizePanel.tsx
│   ├── ScoreGauge.tsx              # animated SVG arc 0–100
│   ├── CategoryCard.tsx
│   ├── CheckRow.tsx                # collapsed + expanded(overview|audit)
│   ├── EvidenceTimeline.tsx
│   ├── CopyPromptButton.tsx
│   └── ThemeToggle.tsx             # System / Light / Dark tri-state
├── vercel.ts
├── next.config.ts
├── package.json
└── tests/
    ├── engine/*.spec.ts            # fixture round-trip against research/raw/*.json
    ├── scoring.spec.ts             # verify 58/100 on cf-dev fixture, levels on all 5 samples
    └── e2e/home.spec.ts            # Playwright: scan example.com, assert render
```

---

## Phases

### Phase 0 — Scaffold (30 min)

- `pnpm create next-app@latest .` — TS, Tailwind, App Router, no `src/` dir
- Install deps: `zod`, `fast-xml-parser`, `@modelcontextprotocol/sdk`, shadcn/ui init, Vitest, Playwright
- Create the directory skeleton above
- Stub `vercel.ts`
- Seed `lib/schema.ts` from `research/FINDINGS.md` §4 (Zod first)
- Git commit: "chore: scaffold Next.js app on Vercel"

### Phase 1 — Engine core + first six checks (2–3 h)

- `lib/engine/context.ts` — shared fetch wrapper that captures `{ request, response, finding }` triples for the evidence timeline
- Port check logic from PromptMention (MIT, attributed in README) for the six simplest checks:
  - `robotsTxt`, `sitemap`, `linkHeaders`, `markdownNegotiation`, `robotsAiRules`, `contentSignals`
- Reshape to Cloudflare's stepped-timeline evidence schema (not PromptMention's flat shape)
- Vitest unit tests driven by `research/raw/*.json` — each check must produce the same verdict the real tool produced on the same site
- Git commit: "feat(engine): core scan runtime + six discoverability/content/access checks"

### Phase 2 — Remaining 13 checks (2–3 h)

- `webBotAuth` — `GET /.well-known/http-message-signatures-directory`; neutral default
- Discovery: `apiCatalog`, `oauthDiscovery`, `oauthProtectedResource`, `mcpServerCard`, `a2aAgentCard`, `agentSkills`
- `webMcp` — static-HTML + linked-JS regex fallback for `navigator.modelContext.{registerTool|provideContext}` references. Annotate in code: "limited fidelity; upgrade path = Vercel Sandbox for real page eval."
- `lib/engine/commerce-signals.ts` — pattern list seeded from observed fixtures: `platform:shopify|woocommerce|magento|bigcommerce`, `meta:*`, `url:/checkout|/product|/shop|/cart`
- Commerce checks: `x402`, `mpp`, `ucp`, `acp`, `ap2` (ap2 derives pass/fail from a2aAgentCard)
- Git commit: "feat(engine): discovery + commerce checks (13 checks, 19 total)"

### Phase 3 — Scoring, levels, API surface (1 h)

- `scoring.ts` — formula from FINDINGS §5: `round(passes / (pass+fail, excluding neutrals + commerce-when-!isCommerce + opt-outs) × 100)`. Verified against fixtures: cf-dev → 58, vercel → 50, example → 0, cloudflare → 31, shopify → 17
- `levels.ts` — level ladder table:
  - L0 Not Ready (baseline)
  - L1 Basic Web Presence: `robotsTxt`, `sitemap`
  - L2 Bot-Aware: L1 + `robotsTxtAiRules`, `contentSignals`
  - L3 Agent-Readable: L2 + `markdownNegotiation`
  - L4 Agent-Integrated: L3 + `linkHeaders`, `agentSkills`
  - L5 Agent-Native: L4 + `apiCatalog`, `oauthProtectedResource`, `mcpServerCard`, `a2aAgentCard`
  - `nextLevel.requirements` synthesizer computes missing required checks for `level + 1`
- `app/api/scan/route.ts` — Zod-validated body; supports `{ url, profile?, enabledChecks?, format? }`; returns JSON by default or `text/markdown` when `format: "agent"`
- `app/mcp/route.ts` — MCP SDK, stateless Streamable HTTP, one tool `scan_site` that delegates to the engine (mirrors schema from FINDINGS §7)
- Git commit: "feat: scoring, level ladder, /api/scan + /mcp routes"

### Phase 4 — Frontend (3–4 h)

- **Homepage (`/`):** H1 "Is Your Site Agent-Ready?", intro paragraph with inline links (Markdown negotiation, MCP, Agent Skills), `<ScanForm>` (URL input + orange Scan button), `<CustomizePanel>` collapsible (site-type radio + per-check checkboxes; `a2aAgentCard` off by default; Commerce group hidden when profile = "Content Site"), three info accordions ("What do we check?", "What's the easiest way to improve my score?", "Where can I learn more?"), disclaimer line, footer.
- **Palette:** Cloudflare orange (`#F6821F`) accent, warm off-white card bg (`#FDF6EE`-ish), near-black text.
- **Theme toggle:** tri-state (System / Light / Dark) using `prefers-color-scheme` + localStorage.
- **Results page (`/[hostname]`):** server-rendered from URL param; same `<ScanForm>` prefilled at top with "Last scanned {date}" note. Score card: "Share score card" button (copies result URL), "Results for {url}", animated `<ScoreGauge>` (SVG arc), Level pill "Level {N}: {name}", 4–5 `<CategoryCard>` mini gauges.
- **"Improve the score"** orange button with badge = count of failing scored checks → scrolls to first fail.
- **`<CheckRow>`:** collapsed state shows status icon (✓ green pass / ✗ red fail / ⚪ neutral "Not applicable") + check name. Fail-state expanded shows two-panel toggle: **overview** (Goal/Issue, How to implement, Resources including spec links + Skill link, `<CopyPromptButton>`, "View audit details" button) and **audit** (`<EvidenceTimeline>`). Pass/neutral just shows the evidence timeline.
- **`<EvidenceTimeline>`:** each step renders action icon + label + status code + req/resp header tables + body preview + finding summary; footer shows total `durationMs`.
- **"Scan another site"** button returns to `/`.
- Git commit: "feat(ui): homepage + customize panel + results page + theme toggle"

### Phase 5 — Dogfood & polish (1 h)

- Mirror `research/skills/*.md` into `lib/skills/` and serve verbatim at `/.well-known/agent-skills/{slug}/SKILL.md` (attribution in README; remove if Cloudflare objects)
- Generate our own `/.well-known/agent-skills/index.json` referencing the mirrored skills + our own `scan-site` skill
- Publish `/robots.txt` with `Content-Signal: ai-train=yes, search=yes, ai-input=yes` (mirrors the original)
- Publish `/llms.txt`, `/sitemap.xml`
- Publish our own `/.well-known/mcp/server-card.json` advertising our `/mcp` endpoint — verifies we score level 5 on our own scanner
- Add ATTRIBUTION.md crediting Cloudflare's original + PromptMention's MIT-licensed check plumbing
- Git commit: "feat: self-host agent-readiness signals (dogfood)"

### Phase 6 — Tests, preview deploy, iteration (1–2 h)

- Vitest green: engine per-check unit tests + `scoring.spec.ts` + `levels.spec.ts` round-tripping all 5 fixtures
- Playwright E2E: scan `example.com` and `developers.cloudflare.com`; assert gauge renders, check rows expand, "Copy prompt" writes to clipboard
- `vercel deploy --prebuilt` for preview URL
- Run our own scanner against our preview URL (should itself score level 4–5 after Phase 5) — ultimate smoke test
- Git commit: "test: engine unit coverage + Playwright happy path"

---

## API contract (target)

### `POST /api/scan`

```json
{
  "url": "https://example.com",
  "profile": "all" | "content" | "apiApp",          // optional
  "enabledChecks": ["robotsTxt", "sitemap", ...],    // optional, overrides profile
  "format": "agent"                                   // optional — returns text/markdown fix prompt
}
```

Response shape matches FINDINGS §4 verbatim — `{ url, scannedAt, level, levelName, checks, nextLevel, isCommerce, commerceSignals }`.

### `POST /mcp`

MCP Streamable HTTP. One tool: `scan_site` with input schema `{ url, profile?, enabledChecks? }`, execution `taskSupport: "forbidden"`. `serverInfo: { name: "Agent Readiness Scanner", version: "1.0.0" }`.

---

## Scoring algorithm (verified)

```ts
score = round(
  passes_of_scored / (passes_of_scored + fails_of_scored) × 100
)
```

Where `scored` excludes:
- `status === "neutral"` checks
- `commerce.*` checks when `isCommerce === false`
- Any check the user explicitly opted out of via `enabledChecks` (in particular `a2aAgentCard` is off by default)

Level ladder is gated by required-check sets (see Phase 3).

---

## Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| WebMCP fidelity without real browser | Medium | Document in check output; upgrade path = Vercel Sandbox (GA Jan 2026) |
| Level thresholds reverse-engineered from 5 samples | Medium | Fixture round-trip tests; easy table tune when mismatches surface |
| Commerce pattern list incomplete | Low | Small observable set; extend as false-negatives surface |
| Target sites may block scanner UA | Low | Clear `User-Agent` + `From` header; graceful 403 fallback |
| Attribution for mirrored SKILL.md content | Low | Verbatim with credit in README; removable on request |
| Copying Cloudflare's UI copy verbatim | Low | Rewrite long-form copy; keep functional labels only |

---

## Complexity & estimate

**MEDIUM** — approximately **10–13 engineering hours** total. PromptMention port saves ~2h of check-plumbing work.

---

## Confirmation checklist

Before Phase 0 begins:
- [ ] User approves stack (Next.js 16 / Tailwind v4 / shadcn / Vercel)
- [ ] User approves phasing (6 phases as above)
- [ ] User approves reuse strategy (fresh build + MIT-attributed check ports from PromptMention + verbatim SKILL.md mirror from Cloudflare with attribution)
- [ ] User approves the static-fallback approach for `webMcp` (Vercel Sandbox upgrade later)

Reply `proceed` to begin Phase 0, or specify modifications.
