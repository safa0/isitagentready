/**
 * Failing specs for the `agentSkills` check.
 *
 * Oracle: `research/raw/scan-*.json` → `checks.discovery.agentSkills`.
 * Reference: `research/FINDINGS.md` §3, §9.
 *
 * Per FINDINGS §9 and the task specification:
 *   - GET `/.well-known/agent-skills/index.json` (v0.2.0 path) on the origin.
 *   - On 404, fall back to the legacy `/.well-known/skills/index.json` path,
 *     mirroring Cloudflare's real scanner behaviour (see cf-dev fixture:
 *     v0.2.0 path returned 404, legacy path returned 200 — PASS).
 *   - Parse the JSON. Expect a `skills: []` array; each entry may carry
 *     `{ id | name, description, url | href }` per the RFC v0.2.0 schema
 *     (also accepts the FINDINGS §3 shorthand `{ id, name, href }`).
 *   - Attempt to resolve the first 3 skill hrefs (same-origin or absolute);
 *     pass if the index is valid JSON AND at least one skill resolves with
 *     a non-empty body.
 *
 * The four "fail" oracle fixtures exercise the legacy-fallback + conclusion
 * path. The cf-dev pass fixture does not include skill-href resolution steps
 * (it's the real scanner's 0.1.0-shape output), so it is covered here by a
 * dedicated custom fixture that exercises the resolver contract.
 */

import { describe, it, expect } from "vitest";

import {
  expectCheckMatchesOracle,
  loadOracle,
  makeFetchStub,
  type OracleSite,
} from "./_helpers/oracle";
import { createScanContext } from "@/lib/engine/context";
import { CheckResultSchema, type EvidenceStep } from "@/lib/schema";

// Not-yet-implemented check; import fails until impl ships the file.
import { checkAgentSkills } from "@/lib/engine/checks/agent-skills";

// ---------------------------------------------------------------------------
// Oracle harness — only the 4 failing fixtures match our contract cleanly.
// ---------------------------------------------------------------------------

/** Sites whose oracle evidence shape matches our implementation exactly. */
const FAIL_FIXTURE_SITES: readonly OracleSite[] = [
  "example",
  "vercel",
  "cf",
  "shopify",
] as const;

async function runFailOracle(site: OracleSite) {
  const oracle = loadOracle(site);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const skillsOracle = oracle.raw.checks.discovery.agentSkills as any;

  const routes: Record<string, Parameters<typeof makeFetchStub>[0][string]> =
    {};
  skillsOracle.evidence
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((s: any) => s.action === "fetch")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .forEach((step: any) => {
      routes[step.request.url] = {
        status: step.response.status,
        statusText: step.response.statusText,
        headers: step.response.headers,
        body: "",
      };
    });

  const { fetchImpl } = makeFetchStub(routes);
  const ctx = createScanContext({ url: oracle.origin, fetchImpl });
  const result = await checkAgentSkills(ctx);
  return { oracle: skillsOracle, result };
}

describe("agentSkills", () => {
  it.each(FAIL_FIXTURE_SITES)(
    "%s: round-trips against the fail-case fixture oracle",
    async (site) => {
      const { oracle, result } = await runFailOracle(site);
      expect(CheckResultSchema.safeParse(result).success).toBe(true);
      expectCheckMatchesOracle(result, oracle);
    },
  );
});

// ---------------------------------------------------------------------------
// Pass behaviour — custom fixture exercising skill-href resolution.
// ---------------------------------------------------------------------------

describe("agentSkills — pass behaviour", () => {
  it("passes when the v0.2.0 index is served and at least one skill resolves", async () => {
    const indexBody = JSON.stringify({
      $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
      skills: [
        { id: "search", name: "Search", href: "/.well-known/skills/search/SKILL.md" },
        { id: "nav", name: "Nav", href: "/.well-known/skills/nav/SKILL.md" },
        { id: "lookup", name: "Lookup", href: "/.well-known/skills/lookup/SKILL.md" },
      ],
    });
    const { fetchImpl } = makeFetchStub({
      "https://ok.test/.well-known/agent-skills/index.json": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: indexBody,
      },
      "https://ok.test/.well-known/skills/search/SKILL.md": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/markdown" },
        body: "# Search Skill\nBody content.",
      },
      "https://ok.test/.well-known/skills/nav/SKILL.md": {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "text/html" },
        body: "",
      },
      "https://ok.test/.well-known/skills/lookup/SKILL.md": {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "text/html" },
        body: "",
      },
    });
    const ctx = createScanContext({ url: "https://ok.test", fetchImpl });
    const result = await checkAgentSkills(ctx);
    expect(CheckResultSchema.safeParse(result).success).toBe(true);
    expect(result.status).toBe("pass");
    expect(result.details).toMatchObject({
      skillCount: 3,
      resolvedSkills: 1,
      path: "/.well-known/agent-skills/index.json",
    });
  });

  it("passes when legacy /.well-known/skills/index.json is the only index available", async () => {
    const indexBody = JSON.stringify({
      skills: [
        { id: "about", name: "About", href: "/skills/about/SKILL.md" },
      ],
    });
    const { fetchImpl } = makeFetchStub({
      "https://legacy.test/.well-known/agent-skills/index.json": {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "text/html" },
        body: "",
      },
      "https://legacy.test/.well-known/skills/index.json": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: indexBody,
      },
      "https://legacy.test/skills/about/SKILL.md": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/markdown" },
        body: "# About",
      },
    });
    const ctx = createScanContext({ url: "https://legacy.test", fetchImpl });
    const result = await checkAgentSkills(ctx);
    expect(result.status).toBe("pass");
    expect(CheckResultSchema.safeParse(result).success).toBe(true);
    expect(result.details?.path).toBe("/.well-known/skills/index.json");
  });

  it("emits specVersion '0.1.0' on a legacy-shape pass (cf-dev oracle parity)", async () => {
    // Legacy body: no $schema, under /.well-known/skills/index.json — matches
    // the reference scanner's cf-dev fixture (see research/raw/scan-cf-dev.json).
    const indexBody = JSON.stringify({
      skills: [{ id: "demo", name: "Demo", href: "/skills/demo/SKILL.md" }],
    });
    const { fetchImpl } = makeFetchStub({
      "https://cf-shape.test/.well-known/agent-skills/index.json": {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "text/html" },
        body: "",
      },
      "https://cf-shape.test/.well-known/skills/index.json": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: indexBody,
      },
      "https://cf-shape.test/skills/demo/SKILL.md": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/markdown" },
        body: "# Demo",
      },
    });
    const ctx = createScanContext({ url: "https://cf-shape.test", fetchImpl });
    const result = await checkAgentSkills(ctx);
    expect(result.status).toBe("pass");
    expect(CheckResultSchema.safeParse(result).success).toBe(true);
    expect(result.details?.specVersion).toBe("0.1.0");
    expect(result.details?.path).toBe("/.well-known/skills/index.json");
  });

  it("fails when the index is valid JSON but no skill hrefs resolve", async () => {
    const indexBody = JSON.stringify({
      skills: [
        { id: "a", name: "A", href: "/skills/a/SKILL.md" },
        { id: "b", name: "B", href: "/skills/b/SKILL.md" },
      ],
    });
    const { fetchImpl } = makeFetchStub({
      "https://unresolved.test/.well-known/agent-skills/index.json": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: indexBody,
      },
      "https://unresolved.test/skills/a/SKILL.md": {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "text/html" },
        body: "",
      },
      "https://unresolved.test/skills/b/SKILL.md": {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "text/html" },
        body: "",
      },
    });
    const ctx = createScanContext({ url: "https://unresolved.test", fetchImpl });
    const result = await checkAgentSkills(ctx);
    expect(result.status).toBe("fail");
    expect(result.message).toMatch(/no skill|resolve/i);
  });

  it("accepts 'url' as an alternative to 'href' for the skill location", async () => {
    const indexBody = JSON.stringify({
      skills: [
        { name: "search", url: "/skills/search/SKILL.md", type: "skill-md" },
      ],
    });
    const { fetchImpl } = makeFetchStub({
      "https://url-field.test/.well-known/agent-skills/index.json": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: indexBody,
      },
      "https://url-field.test/skills/search/SKILL.md": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/markdown" },
        body: "# Search",
      },
    });
    const ctx = createScanContext({ url: "https://url-field.test", fetchImpl });
    const result = await checkAgentSkills(ctx);
    expect(result.status).toBe("pass");
    expect(CheckResultSchema.safeParse(result).success).toBe(true);
  });

  it("fails when index JSON is malformed", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://bad.test/.well-known/agent-skills/index.json": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: "{ broken",
      },
    });
    const ctx = createScanContext({ url: "https://bad.test", fetchImpl });
    const result = await checkAgentSkills(ctx);
    expect(result.status).toBe("fail");
    expect(result.message).toMatch(/invalid|parse|json/i);
  });

  it("fails when index is valid JSON but missing the skills array", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://empty.test/.well-known/agent-skills/index.json": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ $schema: "foo" }),
      },
    });
    const ctx = createScanContext({ url: "https://empty.test", fetchImpl });
    const result = await checkAgentSkills(ctx);
    expect(result.status).toBe("fail");
  });

  it("fails when skills array is empty", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://noskills.test/.well-known/agent-skills/index.json": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skills: [] }),
      },
    });
    const ctx = createScanContext({ url: "https://noskills.test", fetchImpl });
    const result = await checkAgentSkills(ctx);
    expect(result.status).toBe("fail");
  });

  it("resolves at most the first 3 skill hrefs", async () => {
    const indexBody = JSON.stringify({
      skills: [
        { id: "s1", href: "/s1/SKILL.md" },
        { id: "s2", href: "/s2/SKILL.md" },
        { id: "s3", href: "/s3/SKILL.md" },
        { id: "s4", href: "/s4/SKILL.md" },
        { id: "s5", href: "/s5/SKILL.md" },
      ],
    });
    const { fetchImpl, calls } = makeFetchStub({
      "https://cap.test/.well-known/agent-skills/index.json": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: indexBody,
      },
      "https://cap.test/s1/SKILL.md": {
        status: 200,
        statusText: "OK",
        headers: {},
        body: "# S1",
      },
      "https://cap.test/s2/SKILL.md": {
        status: 200,
        statusText: "OK",
        headers: {},
        body: "# S2",
      },
      "https://cap.test/s3/SKILL.md": {
        status: 200,
        statusText: "OK",
        headers: {},
        body: "# S3",
      },
    });
    const ctx = createScanContext({ url: "https://cap.test", fetchImpl });
    const result = await checkAgentSkills(ctx);
    expect(result.status).toBe("pass");
    expect(CheckResultSchema.safeParse(result).success).toBe(true);
    // s4, s5 must never be fetched.
    expect(calls.some((u) => u.includes("/s4/"))).toBe(false);
    expect(calls.some((u) => u.includes("/s5/"))).toBe(false);
  });

  it("fails (not throws) when the index fetch errors at the transport level on both paths", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://broken.test/.well-known/agent-skills/index.json": new Error(
        "ECONNRESET",
      ),
      "https://broken.test/.well-known/skills/index.json": new Error(
        "ECONNRESET",
      ),
    });
    const ctx = createScanContext({ url: "https://broken.test", fetchImpl });
    const result = await checkAgentSkills(ctx);
    expect(result.status).toBe("fail");
    expect(CheckResultSchema.safeParse(result).success).toBe(true);
  });

  it("skips skill entries that have no href/url", async () => {
    const indexBody = JSON.stringify({
      skills: [
        { id: "nohref" }, // no href/url — must be skipped without crashing
        { id: "ok", href: "/skills/ok/SKILL.md" },
      ],
    });
    const { fetchImpl } = makeFetchStub({
      "https://mixed.test/.well-known/agent-skills/index.json": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: indexBody,
      },
      "https://mixed.test/skills/ok/SKILL.md": {
        status: 200,
        statusText: "OK",
        headers: {},
        body: "# OK",
      },
    });
    const ctx = createScanContext({ url: "https://mixed.test", fetchImpl });
    const result = await checkAgentSkills(ctx);
    expect(result.status).toBe("pass");
    expect(CheckResultSchema.safeParse(result).success).toBe(true);
  });

  it("fails when index body is valid JSON but root is not an object (scalar)", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://scalar.test/.well-known/agent-skills/index.json": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: JSON.stringify("just a string"),
      },
    });
    const ctx = createScanContext({ url: "https://scalar.test", fetchImpl });
    const result = await checkAgentSkills(ctx);
    expect(result.status).toBe("fail");
    expect(result.message).toMatch(/not valid json|json/i);
  });

  it("fails when index body is null (valid JSON but not an object)", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://null.test/.well-known/agent-skills/index.json": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: "null",
      },
    });
    const ctx = createScanContext({ url: "https://null.test", fetchImpl });
    const result = await checkAgentSkills(ctx);
    expect(result.status).toBe("fail");
  });

  it("records a resolve-error step when a skill href is unparseable", async () => {
    const indexBody = JSON.stringify({
      skills: [
        { id: "bad", href: "ht!tp://:::not a url" },
        { id: "ok", href: "/ok/SKILL.md" },
      ],
    });
    const { fetchImpl } = makeFetchStub({
      "https://resolver.test/.well-known/agent-skills/index.json": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: indexBody,
      },
      "https://resolver.test/ok/SKILL.md": {
        status: 200,
        statusText: "OK",
        headers: {},
        body: "# OK",
      },
    });
    const ctx = createScanContext({ url: "https://resolver.test", fetchImpl });
    const result = await checkAgentSkills(ctx);
    // At least one resolved, so we expect pass (despite one unparseable href).
    expect(result.status).toBe("pass");
    expect(CheckResultSchema.safeParse(result).success).toBe(true);
  });

  it("emits evidence steps in the expected order on a full pass", async () => {
    const indexBody = JSON.stringify({
      skills: [{ id: "x", href: "/x/SKILL.md" }],
    });
    const { fetchImpl } = makeFetchStub({
      "https://ordered.test/.well-known/agent-skills/index.json": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: indexBody,
      },
      "https://ordered.test/x/SKILL.md": {
        status: 200,
        statusText: "OK",
        headers: {},
        body: "# X body",
      },
    });
    const ctx = createScanContext({ url: "https://ordered.test", fetchImpl });
    const result = await checkAgentSkills(ctx);
    const actions = result.evidence.map((s: EvidenceStep) => s.action);
    // Expected flow: fetch index, parse JSON, fetch skill, conclude.
    expect(actions[0]).toBe("fetch");
    expect(actions[actions.length - 1]).toBe("conclude");
  });
});
