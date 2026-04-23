# isitagentready — Handoff Document

**Date:** 2026-04-23
**Purpose:** Resume work from a fresh Claude Code context. Read this top-to-bottom before doing anything.

---

## 1. What this project is

A Next.js 16 replica of Cloudflare's [isitagentready.com](https://isitagentready.com) on Vercel. Scans a URL, emits a 0–100 score across **19 checks in 5 categories**, and exposes both a REST API and an MCP server.

**Repo:** `safa0/isitagentready` on GitHub. Main branch is always green.

**Tracking docs (read them):**
- `PLAN.md` — implementation plan, 6 phases, full stack, directory layout
- `research/FINDINGS.md` — functional spec from live reverse-engineering
- `research/raw/*.json` — 5 oracle fixtures (cf-dev, vercel, example, cloudflare, shopify)
- `research/skills/*.md` — Cloudflare's agent-skill .md files (mirrored)
- `research/COMPETITIVE_LANDSCAPE.md` — **3-bet differentiation plan** (ship BET A + BET C)

---

## 2. Current state on `main`

### Merged (as of 2026-04-23)

| Phase | PR | Scope | Commit |
|---|---|---|---|
| 0 | — | Next.js 16 + Tailwind v4 + shadcn + Zod schema + dir skeleton | `b3eebcc` |
| 1 | #1 | Discovery-surface checks: robotsTxt, sitemap, linkHeaders | `e7efe33` |
| 1 | #2 | Content + bot rules: markdownNegotiation, robotsTxtAiRules, contentSignals | `4669d0c` |
| 2 | #3 | Auth + MCP discovery: webBotAuth, oauthDiscovery, oauthProtectedResource, apiCatalog, mcpServerCard | `6f21775` |
| 2 | #4 | Agent discovery + webmcp: a2aAgentCard, agentSkills, webMcp | `e70629f` |
| 2 | #5 | Commerce: commerce-signals + x402, mpp, ucp, acp, ap2 | `1be9bbf` |
| 3 | #7 | Scoring, levels, prompts, /api/scan, /mcp, SSRF guard, rate limiter | `03d4a1f` |

**Main HEAD:** `03d4a1f` — **431 tests passing**, typecheck + build clean, perFile 80% coverage gate enforced.

### Not built yet

- **Phase 4:** Frontend (`app/page.tsx` is still Next.js placeholder). This is what to do next.
- **Phase 5:** Dogfood — publish our own `/.well-known/*`, `robots.txt`, `llms.txt`, mirror skills.
- **Phase 6:** E2E Playwright + preview deploy to Vercel.

### Open GitHub issues

- [#6](https://github.com/safa0/isitagentready/issues/6) — **Scoring anomaly** on 3 of 5 fixtures (vercel, cloudflare, shopify). Formula yields 42/33/18 vs PLAN targets 50/31/17. No single exclusion rule satisfies all. **Action later:** re-fetch live. Tests assert formula output with `TODO(#6)` comments.
- [#8](https://github.com/safa0/isitagentready/issues/8) — MCP route explicit `server.close()` / `transport.close()`. Not a correctness bug (stateless per-request GC handles it). Priority: low.

---

## 3. Stack (final)

| Layer | Choice |
|---|---|
| Framework | Next.js 16 App Router on Vercel (Fluid Compute, Node 24) |
| Language | TypeScript strict |
| Styling | Tailwind CSS v4 + shadcn/ui primitives (Button, Accordion, Checkbox, RadioGroup, Input, Label, Separator already installed) |
| Validation | Zod (schema-first — `lib/schema.ts`) |
| XML parsing | `fast-xml-parser` (for sitemap) |
| MCP server | `@modelcontextprotocol/sdk` Streamable HTTP, **stateless per-request allocation** |
| HTTP | native `fetch` + `AbortSignal.timeout` (no axios) |
| State | URL state only, no persistence. React Query OK for scan-in-flight. |
| Testing | Vitest (unit + integration) + Playwright (E2E, Phase 6) |
| Rate limit | in-memory per-IP token bucket with LRU eviction, separate REST (10/min) + MCP (3/min) buckets |
| Package manager | **pnpm@10.33.1** (pinned) |
| Deploy | Single Vercel project (`vercel.json` — there is no `vercel.ts` package) |

---

## 4. Code architecture

### Directory layout on main

```
app/
├── layout.tsx              # stock
├── page.tsx                # stock placeholder (Phase 4 rewrites this)
├── api/scan/route.ts       # POST /api/scan — Zod validation + rate limit + 25s timeout
└── mcp/route.ts            # POST /mcp — stateless Streamable HTTP, scan_site tool

lib/
├── schema.ts               # Zod + TS types (19 check IDs, ScanRequestSchema, ScanResponseSchema, CheckResultSchema, EvidenceStepSchema)
├── utils.ts                # shadcn cn helper (EXCLUDED from coverage)
├── api/
│   └── rate-limiter.ts     # defaultRateLimiter (10/min) + mcpRateLimiter (3/min), extractClientIp with trust gate
└── engine/
    ├── index.ts            # runScan orchestrator
    ├── context.ts          # createScanContext, performFetch, SharedProbes, AbortSignal plumbing
    ├── security.ts         # assertPublicUrl, normaliseScanUrl, ScanUrlError
    ├── scoring.ts          # scoreScan, computeCategoryScores, ALL_CHECK_IDS, CHECK_CATEGORY
    ├── levels.ts           # determineLevel, LEVEL_TABLE
    ├── prompts.ts          # PROMPTS catalog, getAgentReport
    ├── commerce-signals.ts # detectCommerce, applyCommerceGate
    └── checks/
        ├── _shared.ts      # tryParseJson, buildFailNoRobots, AI_BOT_TOKENS
        ├── robots-txt.ts
        ├── sitemap.ts
        ├── link-headers.ts
        ├── markdown-negotiation.ts
        ├── robots-ai-rules.ts
        ├── content-signals.ts
        ├── web-bot-auth.ts
        ├── oauth-discovery.ts
        ├── oauth-protected-resource.ts
        ├── api-catalog.ts
        ├── mcp-server-card.ts
        ├── a2a-agent-card.ts
        ├── agent-skills.ts
        ├── web-mcp.ts
        ├── x402.ts
        ├── mpp.ts
        ├── ucp.ts
        ├── acp.ts
        └── ap2.ts

components/ui/              # shadcn primitives (no app-specific yet)

tests/
├── schema.spec.ts
├── api/
│   ├── rate-limiter.spec.ts
│   └── scan-route.spec.ts
├── mcp/
│   └── mcp-route.spec.ts
└── engine/
    ├── _helpers/oracle.ts         # runCheckAgainstOracle, expectCheckMatchesOracle, ALL_SITES, loadOracle
    ├── _shared.spec.ts
    ├── context.spec.ts
    ├── scoring.spec.ts
    ├── levels.spec.ts
    ├── prompts.spec.ts
    ├── security.spec.ts
    ├── runScan.spec.ts
    └── <each-check>.spec.ts

research/                   # read-only reference
```

### Key design invariants

1. **ScanContext is frozen.** `createScanContext(opts)` returns `Object.freeze(...)`. Contexts are never mutated — widening creates a new context sharing a `SharedProbes` record so the homepage fetch is memoised across both.
2. **All 19 checks share one signature:** `check(ctx: ScanContext): Promise<CheckResult>`. No more `opts` param. Commerce checks read `ctx.isCommerce`; ap2 reads `ctx.a2aAgentCard` + `ctx.a2aAgentCardEnabled`.
3. **Evidence is read-only tuples.** `performFetch` returns `FetchOutcome { request, response, body, error, durationMs }`. Each check builds `EvidenceStep[]` via `fetchToStep` + `makeStep` (immutable).
4. **SSRF defence is multi-layer:** literal IPv4/IPv6 private-range classifier + 6to4/NAT64/site-local prefixes + URL credential rejection + scheme allow-list + per-hop redirect validation (max 3 hops) + response body cap (1 MiB). **DNS rebinding is a documented gap** — out of scope until Phase 4+.
5. **AbortSignal is plumbed end-to-end.** Route → `runScan` → context → every `performFetch`. 25s scan cap at route level (vercel maxDuration is 30s).
6. **Rate-limit trust posture:** `x-vercel-forwarded-for` / `x-forwarded-for` are ignored unless `VERCEL=1` or `TRUST_FORWARDED=true`. Off-platform falls back to a shared `"unknown"` bucket (DoS-able but not spoofable).
7. **CHECK_CATEGORY is the single source of truth.** `projectByCategory`, `scoreScan`, `determineLevel`, `PARALLEL_IDS` all derive from it. Adding a 20th check means editing 5 files (enum, CHECK_CATEGORY, RUNNERS, PROMPTS, level-ladder if it gates a level).

### API contract (POST /api/scan)

```jsonc
// Request
{
  "url": "https://example.com",        // required, http(s), max 2048 chars, no credentials, public host
  "profile": "all" | "content" | "apiApp",  // optional, default "all"
  "enabledChecks": ["robotsTxt", ...], // optional, overrides profile, max 19
  "format": "agent"                     // optional — returns text/markdown instead of JSON
}

// Response: ScanResponseSchema (lib/schema.ts)
{
  "url": "...",
  "scannedAt": "2026-...",
  "level": 0-5,
  "levelName": "Not Ready" | "Basic Web Presence" | "Bot-Aware" | "Agent-Readable" | "Agent-Integrated" | "Agent-Native",
  "checks": {
    "discoverability": { robotsTxt, sitemap, linkHeaders },
    "contentAccessibility": { markdownNegotiation },
    "botAccessControl": { robotsTxtAiRules, contentSignals, webBotAuth },
    "discovery": { apiCatalog, oauthDiscovery, oauthProtectedResource, mcpServerCard, a2aAgentCard, agentSkills, webMcp },
    "commerce": { x402, mpp, ucp, acp, ap2 }
  },
  "nextLevel": { level, name, requirements: [CheckId...] } | null,
  "isCommerce": boolean,
  "commerceSignals": string[]
}

// Headers on every response (200 + 429 + 500)
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 9
X-RateLimit-Reset: <epoch-seconds>
```

**Top-level `score` is NOT in the schema** — matches Cloudflare's oracle shape. UI derives from `checks.*.status` via `scoreScan(results, opts)`.

### MCP contract (POST /mcp)

- Streamable HTTP, stateless, one transport per request
- `serverInfo: { name: "Agent Readiness Scanner", version: "1.0.0" }`
- One tool: `scan_site` with input `{ url, profile?, enabledChecks? }` (wrapped in `z.object`, `.shape` passed to `registerTool`)
- `taskSupport: "forbidden"`
- Separate rate-limit bucket (3/min, tighter than REST because of the ~19 outbound fan-out amplification)
- Static `"Internal MCP error"` envelope on outer catch (no internal leakage)

---

## 5. Orchestration methodology (how we worked)

**This is the critical handoff section. Read carefully.**

### The pattern that works: Plan B

**Do NOT spawn `agent-teams:team-lead` and expect it to spawn sub-agents.** It doesn't have the `Agent` tool in its toolset — its only options are Read/Glob/Grep/Bash.

**Instead, YOU (the main Claude) are the orchestrator.** Spawn worker agents directly via the `Agent` tool. The resident "team" members (`tdd`, `code-reviewer`, etc.) that get spawned via `TeamCreate` + `Agent` go idle after spawning and don't reliably pick up work from the mailbox — they were shut down in this project.

### Per-task workflow

For each implementer task:

1. **TaskCreate** with strict file ownership list + success criteria + fixture round-trip targets.
2. **Create a worktree + feature branch:**
   ```bash
   git worktree add /Users/safa/Documents/repos/iar-wt-<slug> -b feat/<slug> main
   ```
3. **Empty-commit + push + open draft PR:**
   ```bash
   cd /Users/safa/Documents/repos/iar-wt-<slug>
   git commit --allow-empty -m "chore: open PR for <slug>"
   git push -u origin feat/<slug>
   gh pr create --draft --repo safa0/isitagentready --title "..." --body "..."
   ```
4. **Spawn the implementer via `Agent` tool** with `subagent_type: "agent-teams:team-implementer"`, `model: "opus"`, `run_in_background: true`. Self-contained prompt covering: file ownership, TDD workflow (RED→GREEN), success criteria, commit message, push + `gh pr ready`.
5. **When the implementer reports done, run 3 iterations of reviews:**
   - **Iter 1:** CodeRabbit CLI + code-reviewer + reviewer-test (+ security + architecture if Phase 3 or 5)
   - **Iter 2:** after impl applies fixes, re-review all dimensions
   - **Iter 3:** final polish pass, must be CLEAN from all reviewers + CodeRabbit before merge
6. **Merge via `gh pr merge <n> --squash --delete-branch`.**
7. **Clean up:** `git worktree remove /Users/safa/Documents/repos/iar-wt-<slug> --force`, `TaskUpdate` → completed.

### Review dimensions (spawn these as parallel background agents)

| Dimension | subagent_type | Use when |
|---|---|---|
| Code quality | `everything-claude-code:code-reviewer` | Every PR |
| Testing | `agent-teams:team-reviewer` (testing dim) | Every PR |
| Security | `agent-teams:team-reviewer` (security dim) | Phase 3, 5, or any public-surface PR |
| Architecture | `agent-teams:team-reviewer` (architecture dim) | Phase 3, 5, or any major structural PR |
| CodeRabbit | `coderabbit review --plain --base main` (CLI via Bash, bg) | Every PR. **Use `--agent` flag for structured JSON output** when plain-text truncates. |

Always spawn with `model: "opus"`, `run_in_background: true`. Dispatch all dimensions in one message with N parallel tool-use blocks.

### CodeRabbit quirks

- **Plain output is truncated.** The CLI prints multiple findings but `tail` only shows the last one. Use `coderabbit review --agent --base main` for JSON-per-line structured findings.
- **Rate-limited aggressively.** Expect 5–15 min cooldowns during dense iteration cycles. Use `sleep N && coderabbit ...` in a bg job to schedule retries.
- **Iter-N findings can be contradictory.** Iter-1 told us to wrap MCP inputSchema in `z.object({...})`; later iters flip-flopped between passing `.shape` and the full ZodObject. Trust the MCP SDK signature (`ZodRawShapeCompat | AnySchema` — both work) and your tests.
- **One new finding per iteration is normal.** Don't chase infinitely. User's rule is "at least 3 iterations before merge" — past 3, if all human reviewers say MERGE and CodeRabbit findings are low-severity style/docs, file follow-up issues and merge.

### Worker types and when to use them

| Need | Agent type |
|---|---|
| Write + test + push code | `agent-teams:team-implementer` |
| Fix build/type errors only | `everything-claude-code:build-error-resolver` |
| TDD guide (tests first) | `everything-claude-code:tdd-guide` — **note:** mailbox-dispatch didn't work reliably; better to fold TDD into impl prompt directly |
| Review code | `everything-claude-code:code-reviewer` |
| Review other dimensions | `agent-teams:team-reviewer` |
| E2E testing with browser | `everything-claude-code:e2e-runner` (Phase 6) |
| Research / web search | `general-purpose` |

### User-confirmed orchestration rules (non-negotiable)

1. All worker agents run on `opus` (opus-4-7). Pass `model: "opus"` every spawn.
2. Every PR uses a worktree + feature branch. Worktree: `/Users/safa/Documents/repos/iar-wt-<slug>`, branch: `feat/<slug>`.
3. Merge style: **squash** (`gh pr merge --squash --delete-branch`).
4. Every PR goes through GitHub — no direct-to-main commits except Phase 0.
5. **CodeRabbit review + 3+ fix-and-test iterations** before merge. Even if iter-1 is clean, do 3 rounds.
6. User is strict about 3 iterations; past 3, use judgment based on finding severity.

### Task file ownership enforcement

Each implementer task prompt MUST list the files they may edit, AND the files they may read-only reference (like `lib/schema.ts` after Phase 0, the oracle helpers, fixtures, FINDINGS.md). This prevents parallel implementer conflicts when we fan out. Example template used throughout:

> ## Files you own (exclusive)
> - lib/engine/checks/foo.ts
> - tests/engine/foo.spec.ts
>
> ## You may read-only
> - lib/schema.ts
> - lib/engine/context.ts
> - research/raw/*.json

---

## 6. Testing patterns (learned)

### Oracle round-trip (Phase 1 convention)

Every check has a spec iterating `ALL_SITES` (the 5 fixtures). The shared helper `tests/engine/_helpers/oracle.ts` exports:
- `loadOracle(site)` — reads `research/raw/scan-<site>.json`
- `runCheckAgainstOracle<R>({ site, getOracleEntry, runCheck, ...opts })` — builds a fetch stub from the oracle's recorded evidence and runs the check against it
- `expectCheckMatchesOracle(result, oracle, { evidenceOrder: "strict" | "by-label" })` — asserts status + message + evidenceSteps parity

Use `evidenceOrder: "by-label"` when the oracle's step order reflects network-race non-determinism (concurrent probes). Always also pin `evidence[0]`, terminal `conclude` step, and any critical middle steps with explicit `.label` checks.

### Fixture bodyPreview truncation (known gap)

Oracle `bodyPreview` is capped at ~500 chars. Checks that scan past that (e.g. `commerce-signals` for shopify) can't full-round-trip against oracle evidence. Tests synthesise bodies from `details` fields where needed — document this in the spec file header.

### Determinism rules

- All fetches mocked via `fetchImpl` injection through `createScanContext` — never real network.
- No `.only`, no `.skip`.
- `durationMs` is flex (excluded from `expectCheckMatchesOracle` comparison).
- Re-run twice to confirm identical pass count before claiming determinism.

### Coverage thresholds

`vitest.config.ts` sets `perFile: true` with 80% on lines/branches/functions/statements. Includes `lib/**/*.ts` AND `app/**/route.ts`. Excludes `lib/utils.ts` (shadcn re-export) and `lib/engine/index.ts` (Phase 0 stub; now real but kept excluded — revisit when cleanup warranted).

---

## 7. Competitive context (read before Phase 4)

**`research/COMPETITIVE_LANDSCAPE.md`** — 313-line decision doc.

Key findings:
- ~10 competing scanners exist (not just Cloudflare). Closest threat is **Convrgent AEO Scanner** — already charges $5/scan in USDC via x402.
- **Cloudflare's moats** (brand, URL Scanner API, Radar, spec co-authorship) are unbeatable in 2–4 weeks. Accept parity.
- **Cloudflare's gaps:** no CI/GitHub Action, no monitoring, closed-source engine.
- **Recommended bets (user has not chosen yet):**
  - **BET A:** GitHub Action + SDK + PR-fix bot — CI-first positioning
  - **BET C:** Open-source the engine (MIT) + plugin model — "standard body" positioning
  - **BET B (defer):** weekly monitoring + public leaderboard — conflicts with PLAN "no accounts, no persistence"
- **5 first-mover protocol checks** ready to ship: UCP manifest, MPP v1 alignment, signed A2A cards, WebMCP via Vercel Sandbox, Content-Signal HTTP response header.

**Decision needed from user before Phase 4+:** stay pure-replica (follow PLAN as-is) vs. pivot toward BET A+C. Can be deferred until after Phase 4 ships a baseline UI.

---

## 8. How to resume in a fresh context

### Step 1: Get oriented
```bash
cd /Users/safa/Documents/repos/isitagentready
cat HANDOFF.md          # this file
cat PLAN.md             # phase-by-phase plan
git log --oneline -10   # merged work
gh pr list              # nothing open
gh issue list           # #6 scoring, #8 MCP close
pnpm test --run | tail -4   # 431/431 expected
```

### Step 2: Smoke test manually
```bash
pnpm dev
# in another terminal:
curl -X POST http://localhost:3000/api/scan \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}' | jq .
```
UI is the Next.js placeholder — Phase 4 fixes that.

### Step 3: Kick off Phase 4 — UI

Phase 4 scope per `PLAN.md`:
- **impl-G (primitives):** `components/ScoreGauge.tsx`, `components/CategoryCard.tsx`, `components/CheckRow.tsx`, `components/EvidenceTimeline.tsx`, `components/CopyPromptButton.tsx`
- **impl-H (pages + forms):** `components/ScanForm.tsx`, `components/CustomizePanel.tsx`, `components/ThemeToggle.tsx`, rewrite `app/page.tsx`, new `app/[hostname]/page.tsx`

Sequential — H depends on G. Dispatch order:
1. Create one worktree `iar-wt-phase4-primitives`, branch `feat/phase4-primitives`.
2. Open draft PR.
3. Spawn impl-G (see template below).
4. 3-iteration review loop → merge.
5. Second worktree `iar-wt-phase4-pages`, branch `feat/phase4-pages`.
6. Spawn impl-H (can import primitives from merged main).
7. 3-iteration review loop → merge.
8. Phase 4 done. Move to Phase 5 (dogfood well-known endpoints) and Phase 6 (E2E + deploy).

**Visual references:**
- `isitagentready-home.png` — homepage
- `isitagentready-customize-open.png` — customize panel expanded
- `isitagentready-results-cfdev.png` — results page for developers.cloudflare.com

**Design tokens from PLAN.md §Phase 4:**
- Cloudflare orange accent: `#F6821F`
- Warm off-white card bg: `#FDF6EE`-ish
- Near-black text
- Tri-state theme toggle: System / Light / Dark via `prefers-color-scheme` + localStorage
- Animated SVG arc for score 0–100
- Per-check accordion: collapsed (status icon + name) → expanded (two-panel: overview + audit-details)
- Evidence timeline: action icon + label + status code + req/resp header tables + body preview + finding summary + total durationMs

### Step 4: impl-G spawn template

```typescript
Agent({
  subagent_type: "agent-teams:team-implementer",
  model: "opus",
  run_in_background: true,
  description: "impl-G: Phase 4 UI primitives",
  prompt: `You are impl-G, Phase 4 of the isitagentready project.

## Scope
Build 5 UI primitives using strict TDD + React Testing Library (if time) or snapshot tests.

**Worktree:** /Users/safa/Documents/repos/iar-wt-phase4-primitives
**Branch:** feat/phase4-primitives
**PR:** #<N> (you'll open it after empty commit)

## Files you own (exclusive)
- components/ScoreGauge.tsx
- components/CategoryCard.tsx
- components/CheckRow.tsx
- components/EvidenceTimeline.tsx
- components/CopyPromptButton.tsx
- tests/components/*.spec.tsx (or similar)

## Files you may read
- lib/schema.ts (CheckResult, EvidenceStep, ScanResponse)
- lib/engine/prompts.ts (getPromptFor)
- lib/engine/scoring.ts (scoreScan, computeCategoryScores, CHECK_CATEGORY)
- lib/engine/levels.ts (determineLevel)
- components/ui/* (shadcn primitives — Accordion etc.)
- app/globals.css (Tailwind v4 + theme tokens)
- PLAN.md §Phase 4
- *.png in repo root (visual reference)

## Design tokens
- Accent: #F6821F (Cloudflare orange)
- Card bg (light): warm off-white #FDF6EE; (dark): near-black
- Typography: system font stack, tracking-tight on headings
- Theme: use Tailwind v4 dark: variants; no next-themes dependency yet

## Component specs
### <ScoreGauge score={0-100} size={"sm"|"md"|"lg"} />
SVG arc sweeping 0→100% (e.g., 270° arc like a speedometer). Central number in tabular-nums. Color ramp: red <40, orange 40-70, green >=70. Animated stroke-dasharray on mount via CSS transition. Accessible: aria-valuenow, aria-label.

### <CategoryCard category={CategoryId} score={number} passes={number} fails={number} />
Small card: category name, score, mini gauge (reuse ScoreGauge size="sm"), pass/fail pill counts.

### <CheckRow check={CheckResult} onCopyPrompt={() => void} />
Collapsed state: status icon (✓ green pass / ✗ red fail / ⚪ neutral "Not applicable") + check name.
Expanded via Accordion (shadcn):
- Two tabs/buttons: "Overview" and "Audit details"
- Overview: Goal/Issue text, How to implement, Resources (spec links), <CopyPromptButton>, "View audit details" button (switches tab)
- Audit: <EvidenceTimeline evidence={check.evidence} />
Pass/neutral just shows audit timeline directly.

### <EvidenceTimeline evidence={EvidenceStep[]} />
Vertical list. Each step: action icon (fetch/parse/validate/navigate/conclude) + label + status code (if request/response present) + collapsible req/resp header tables + body preview (<pre>, max-h-40, overflow-auto) + finding summary. Footer: total durationMs.

### <CopyPromptButton checkId={CheckId} />
Button that calls navigator.clipboard.writeText(getPromptFor(checkId)) with visual "Copied!" state for 2s.

## TDD workflow (strict)
1. RED: spec per component. Prefer render-and-assert via vitest + @testing-library/react (install if needed; otherwise snapshot tests are fine for primitives).
2. GREEN: implement. Use tailwind class strings. Prefer server components where no interactivity; "use client" only for CheckRow (accordion state), CopyPromptButton (clipboard), and interactive bits.
3. pnpm test --coverage: all pass, ≥80% per-file.
4. pnpm typecheck && pnpm build: clean.
5. Visual smoke: pnpm dev, eyeball in browser. Since page.tsx still placeholder, add a dev-only route app/dev/primitives/page.tsx that mounts each with sample props (import fixture data from research/raw/scan-cf-dev.json). Remove or gate behind NODE_ENV in prod.
6. Commit: feat(ui): phase 4 primitives — ScoreGauge, CategoryCard, CheckRow, EvidenceTimeline, CopyPromptButton
7. Push + gh pr ready <n>

## Final report
- Commit SHAs
- Test count + coverage per component
- PR status
- Screenshot if you captured any

If visual design ambiguous (e.g. exact gauge sweep angle), STOP and ask.

Go.`
})
```

### Step 5: When impl-G lands, repeat pattern for impl-H

impl-H prompt should focus on:
- Homepage (`/`) — H1, intro paragraph with inline links, `<ScanForm>`, `<CustomizePanel>`, 3 info accordions, disclaimer, footer
- Results page (`/[hostname]`) — server-rendered from URL param, same `<ScanForm>` at top prefilled, `<ScoreGauge>`, Level pill, 4-5 `<CategoryCard>` grid, `<CheckRow>` grouped by category, "Improve the score" button scrolling to first fail, "Scan another site" footer
- `<ScanForm>` — URL input + orange Scan button + loading state (use React Query for scan-in-flight)
- `<CustomizePanel>` — collapsible, site-type radio, per-check checkboxes (a2aAgentCard off by default, Commerce group hidden when profile === "content")
- `<ThemeToggle>` — tri-state System/Light/Dark via prefers-color-scheme + localStorage

---

## 9. Commands cheat-sheet

```bash
# Local dev
pnpm dev                    # next dev
pnpm test                   # vitest
pnpm test --coverage        # with per-file gate
pnpm typecheck              # tsc --noEmit
pnpm build                  # next build
pnpm lint                   # eslint

# Git / PR
git worktree add /Users/safa/Documents/repos/iar-wt-<slug> -b feat/<slug> main
git worktree list
git worktree remove /Users/safa/Documents/repos/iar-wt-<slug> --force
gh pr create --draft --repo safa0/isitagentready --title "..." --body "..."
gh pr ready <n>
gh pr view <n> --repo safa0/isitagentready --json state,mergeable,headRefOid
gh pr merge <n> --squash --delete-branch --repo safa0/isitagentready

# CodeRabbit (install: https://coderabbit.ai/cli)
cd /Users/safa/Documents/repos/iar-wt-<slug>
coderabbit review --plain --base main       # plain text
coderabbit review --agent --base main       # structured JSON (use when findings > 1)

# Manual API smoke
curl -X POST http://localhost:3000/api/scan \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}' | jq .

# MCP smoke
curl -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-01-01","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

---

## 10. Anti-patterns — don't repeat these

1. **Don't spawn `agent-teams:team-lead` expecting it to create sub-agents.** It can't. Orchestrate from the main Claude directly.
2. **Don't rely on mailbox-dispatch for resident team members.** The `tdd`/`code-reviewer`/etc. agents we spawned via `TeamCreate` went idle and never picked up work. Spawn per-task via `Agent` tool.
3. **Don't chase CodeRabbit past 5 iterations.** Past 3-4 iters, new findings tend to be style/doc suggestions that conflict with earlier CodeRabbit advice. File follow-up issues, merge.
4. **Don't pass oracle fixtures into tests via `require()`.** Use `import ... from "../../research/raw/scan-X.json" with { type: "json" }` or `new URL("...", import.meta.url)`.
5. **Don't mutate `routes` inside `extraRoutes` callback for the shared oracle runner.** The runner now guards against this — throws if a key is overwritten.
6. **Don't put test-only hooks (`__resetRateLimiter`) on route modules.** Export them from their source module (`lib/api/rate-limiter.ts`) and import directly in tests.
7. **Don't use `!` non-null assertions.** Explicit guards: `const x = arr[i]; if (x === undefined) continue;`.
8. **Don't use `any`.** Use `unknown` + narrowing or type predicates.
9. **Don't compute `score` then discard it.** UI consumers call `scoreScan` themselves — `ScanResponse` does NOT expose a top-level `score` field (matches oracle shape).
10. **Don't touch `research/raw/*.json`.** They're the oracle. If you re-capture, do it in a separate PR with clear provenance.

---

## 11. User's stated preferences

- opus-4-7 for all orchestrated agents (model: "opus").
- 3+ iterations with CodeRabbit + human reviewers before merge.
- Squash merges with conventional commit titles.
- Worktree + feature branch for every PR from Phase 1 onward.
- Direct commits to main OK only for Phase 0 and orchestrator-owned shared files (`lib/engine/context.ts`, `lib/engine/index.ts`, `vitest.config.ts` when raising thresholds etc.).
- User reads diff/PR on GitHub; doesn't want long narrative status updates — punchy status with PR numbers + SHAs preferred.
- Emoji only if explicitly requested.

---

## 12. Quick-start prompt for the next session

When you (future Claude) start fresh, first message should be:

> Read `HANDOFF.md` in full. Then run `pnpm test --run | tail -4` to confirm main is green. Then ask the user what they want: (a) kick off Phase 4 UI, (b) pivot based on `research/COMPETITIVE_LANDSCAPE.md`, (c) something else.

That's it. You have everything you need in this file.
