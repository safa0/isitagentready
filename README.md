# isitagentready

A faithful open-source replica of [Cloudflare's isitagentready.com](https://isitagentready.com/) — a "Lighthouse for AI agents" scanner that runs 19 standards checks across 5 categories against any origin and returns a score, readiness level, per-check evidence, and copy-paste fix prompts.

> **Status:** in development. See [PLAN.md](./PLAN.md) for the current phase.

## Stack

- Next.js 16 (App Router, Fluid Compute on Node 24)
- TypeScript strict + Tailwind CSS v4 + shadcn/ui
- Zod schemas, `fast-xml-parser` for sitemaps, `@modelcontextprotocol/sdk` for `/mcp`
- Vitest + Playwright
- Deploys to Vercel

## Quickstart

```bash
pnpm install
pnpm dev
pnpm test
```

## Reuse & attribution

This project **is not a fork** of Cloudflare's site. It is a ground-up implementation whose functional spec was reverse-engineered from the live site — see [`research/FINDINGS.md`](./research/FINDINGS.md) for the full spec and the raw scan fixtures in [`research/raw/`](./research/raw/) used as test oracles.

Individual check implementations are ported from [PromptMention/isitagentready](https://github.com/PromptMention/isitagentready) (MIT). The SKILL.md implementation guides served under `/.well-known/agent-skills/` are mirrored verbatim from Cloudflare's canonical set — see [ATTRIBUTION.md](./ATTRIBUTION.md) (added in Phase 5).

## Routes

| Path | Purpose |
|---|---|
| `/` | Homepage + scan form |
| `/{hostname}` | Results page |
| `POST /api/scan` | JSON scan API (`format: "agent"` returns markdown) |
| `POST /mcp` | Stateless Streamable HTTP MCP server — one tool `scan_site` |
| `/.well-known/agent-skills/*` | Skill discovery + mirrored SKILL.md files |
| `/.well-known/mcp/server-card.json` | Our own MCP server card (dogfood) |
| `/robots.txt`, `/sitemap.xml`, `/llms.txt` | Standard discovery files |

## License

MIT. See `LICENSE` (added in Phase 5 alongside attribution).
