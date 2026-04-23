/**
 * Failing specs for the `webMcp` check.
 *
 * Oracle: `research/raw/scan-*.json` → `checks.discovery.webMcp`.
 * Reference: `research/FINDINGS.md` §3, §9, §13 (gaps).
 *
 * IMPLEMENTATION NOTE: the reference scanner uses a headless Chromium to
 * evaluate page JS and detect `navigator.modelContext.{registerTool,
 * provideContext}` calls at runtime. Our static fallback cannot do real JS
 * evaluation, so evidence steps diverge from the oracle shape. What we CAN
 * honour on-oracle is the final `status` and `message`: every fixture's site
 * lacks any static reference to `navigator.modelContext`, and we produce the
 * same `"No WebMCP tools detected on page load"` fail verdict.
 *
 * Static-fallback detection flow:
 *   1. Fetch the homepage HTML.
 *   2. Scan all inline <script> blocks for the regex.
 *   3. Collect all <script src="..."> URLs; fetch each same-origin script and
 *      scan its body for the regex (SSRF guard: skip cross-origin). Emit an
 *      evidence step noting each cross-origin skip.
 *   4. Pass if ANY source contains `navigator.modelContext.registerTool` or
 *      `navigator.modelContext.provideContext`.
 */

import { describe, it, expect } from "vitest";

import {
  ALL_SITES,
  loadOracle,
  makeFetchStub,
  type OracleSite,
} from "./_helpers/oracle";
import { createScanContext } from "@/lib/engine/context";
import { CheckResultSchema, type EvidenceStep } from "@/lib/schema";

// Not-yet-implemented check; import fails until impl ships the file.
import { checkWebMcp } from "@/lib/engine/checks/web-mcp";

// ---------------------------------------------------------------------------
// Oracle round-trip — we assert on status + message only (evidence shape
// diverges because we're a static fallback, not a real browser).
// ---------------------------------------------------------------------------

async function runOracle(site: OracleSite) {
  const oracle = loadOracle(site);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const webMcpOracle = oracle.raw.checks.discovery.webMcp as any;

  // Every fixture's oracle records "No WebMCP tools". Our static fallback
  // must still produce that verdict when the homepage has no references and
  // no linked scripts do either. We stub the homepage with an empty HTML
  // body so the fallback exits cleanly.
  const routes: Record<string, Parameters<typeof makeFetchStub>[0][string]> = {
    [`${oracle.origin}/`]: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/html" },
      body: "<!doctype html><html><head></head><body>no tools</body></html>",
    },
  };

  const { fetchImpl } = makeFetchStub(routes);
  const ctx = createScanContext({ url: oracle.origin, fetchImpl });
  const result = await checkWebMcp(ctx);
  return { oracle: webMcpOracle, result };
}

describe("webMcp", () => {
  it.each(ALL_SITES)(
    "%s: status + message match the oracle (evidence shape diverges by design)",
    async (site) => {
      const { oracle, result } = await runOracle(site);
      expect(CheckResultSchema.safeParse(result).success).toBe(true);
      expect(result.status).toBe(oracle.status);
      expect(result.message).toBe(oracle.message);
    },
  );
});

// ---------------------------------------------------------------------------
// Static fallback — pass paths
// ---------------------------------------------------------------------------

describe("webMcp — static fallback pass paths", () => {
  it("passes when the homepage contains inline navigator.modelContext.registerTool", async () => {
    const html = `<!doctype html><html><body>
      <script>
        navigator.modelContext.registerTool({ name: "search" });
      </script>
    </body></html>`;
    const { fetchImpl } = makeFetchStub({
      "https://inline.test/": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html" },
        body: html,
      },
    });
    const ctx = createScanContext({ url: "https://inline.test", fetchImpl });
    const result = await checkWebMcp(ctx);
    expect(result.status).toBe("pass");
    expect(result.message).toMatch(/webmcp|modelcontext|detected/i);
    expect(result.details).toMatchObject({
      foundIn: expect.any(String),
      pattern: expect.any(String),
    });
  });

  it("passes when the homepage inline script uses provideContext", async () => {
    const html = `<html><body><script>
      navigator.modelContext.provideContext({ hint: "ok" });
    </script></body></html>`;
    const { fetchImpl } = makeFetchStub({
      "https://provide.test/": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html" },
        body: html,
      },
    });
    const ctx = createScanContext({ url: "https://provide.test", fetchImpl });
    const result = await checkWebMcp(ctx);
    expect(result.status).toBe("pass");
  });

  it("passes when a same-origin linked script contains the API call", async () => {
    const html = `<html><body>
      <script src="/assets/app.js"></script>
    </body></html>`;
    const { fetchImpl } = makeFetchStub({
      "https://linked.test/": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html" },
        body: html,
      },
      "https://linked.test/assets/app.js": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/javascript" },
        body: "navigator.modelContext.registerTool({ name: 'x' });",
      },
    });
    const ctx = createScanContext({ url: "https://linked.test", fetchImpl });
    const result = await checkWebMcp(ctx);
    expect(result.status).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// SSRF guard — cross-origin scripts must be skipped, with evidence.
// ---------------------------------------------------------------------------

describe("webMcp — SSRF guard", () => {
  it("skips cross-origin script tags and emits a skip evidence step", async () => {
    const html = `<html><body>
      <script src="https://cdn.example.com/external.js"></script>
    </body></html>`;
    const { fetchImpl, calls } = makeFetchStub({
      "https://guard.test/": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html" },
        body: html,
      },
    });
    const ctx = createScanContext({ url: "https://guard.test", fetchImpl });
    const result = await checkWebMcp(ctx);
    expect(result.status).toBe("fail");
    // Cross-origin script must never have been fetched.
    expect(calls.some((u) => u.startsWith("https://cdn.example.com/"))).toBe(
      false,
    );
    const skipStep = result.evidence.find(
      (s) =>
        s.finding.summary.toLowerCase().includes("cross-origin") ||
        s.finding.summary.toLowerCase().includes("skip"),
    );
    expect(skipStep).toBeDefined();
  });

  it("allows absolute same-origin script URLs", async () => {
    const html = `<html><body>
      <script src="https://same.test/bundle.js"></script>
    </body></html>`;
    const { fetchImpl } = makeFetchStub({
      "https://same.test/": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html" },
        body: html,
      },
      "https://same.test/bundle.js": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/javascript" },
        body: "navigator.modelContext.registerTool({});",
      },
    });
    const ctx = createScanContext({ url: "https://same.test", fetchImpl });
    const result = await checkWebMcp(ctx);
    expect(result.status).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// Fail paths and robustness
// ---------------------------------------------------------------------------

describe("webMcp — fail paths", () => {
  it("fails when the homepage has no navigator.modelContext references at all", async () => {
    const html = "<html><body><script>console.log('nothing')</script></body></html>";
    const { fetchImpl } = makeFetchStub({
      "https://nope.test/": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html" },
        body: html,
      },
    });
    const ctx = createScanContext({ url: "https://nope.test", fetchImpl });
    const result = await checkWebMcp(ctx);
    expect(result.status).toBe("fail");
    expect(result.message).toBe("No WebMCP tools detected on page load");
  });

  it("fails (not throws) when the homepage fetch errors at the transport level", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://broken.test/": new Error("ECONNRESET"),
    });
    const ctx = createScanContext({ url: "https://broken.test", fetchImpl });
    const result = await checkWebMcp(ctx);
    expect(result.status).toBe("fail");
    expect(CheckResultSchema.safeParse(result).success).toBe(true);
  });

  it("fails gracefully when a linked same-origin script 404s", async () => {
    const html = `<html><body>
      <script src="/missing.js"></script>
    </body></html>`;
    const { fetchImpl } = makeFetchStub({
      "https://scripts404.test/": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html" },
        body: html,
      },
      "https://scripts404.test/missing.js": {
        status: 404,
        statusText: "Not Found",
        headers: {},
        body: "",
      },
    });
    const ctx = createScanContext({ url: "https://scripts404.test", fetchImpl });
    const result = await checkWebMcp(ctx);
    expect(result.status).toBe("fail");
  });

  it("does NOT falsely detect a superficial mention in prose", async () => {
    const html = `<html><body>
      <p>We do not use navigator.modelContext on this page.</p>
    </body></html>`;
    const { fetchImpl } = makeFetchStub({
      "https://prose.test/": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html" },
        body: html,
      },
    });
    const ctx = createScanContext({ url: "https://prose.test", fetchImpl });
    const result = await checkWebMcp(ctx);
    // "navigator.modelContext" alone (no .registerTool / .provideContext) is
    // not a positive signal — the check must remain a fail.
    expect(result.status).toBe("fail");
  });

  it("caps the number of linked scripts fetched to avoid ballooning probe count", async () => {
    // Many same-origin scripts: implementation should cap at a reasonable N.
    const scriptTags = Array.from(
      { length: 25 },
      (_, i) => `<script src="/s${i}.js"></script>`,
    ).join("");
    const html = `<html><body>${scriptTags}</body></html>`;
    const routes: Record<string, Parameters<typeof makeFetchStub>[0][string]> =
      {
        "https://many.test/": {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "text/html" },
          body: html,
        },
      };
    for (let i = 0; i < 25; i++) {
      routes[`https://many.test/s${i}.js`] = {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/javascript" },
        body: "/* empty */",
      };
    }
    const { fetchImpl, calls } = makeFetchStub(routes);
    const ctx = createScanContext({ url: "https://many.test", fetchImpl });
    const result = await checkWebMcp(ctx);
    expect(result.status).toBe("fail");
    // Homepage + at most 20 scripts fetched (implementation cap).
    expect(calls.length).toBeLessThanOrEqual(21);
  });
});

// ---------------------------------------------------------------------------
// Evidence shape
// ---------------------------------------------------------------------------

describe("webMcp — evidence shape", () => {
  it("records a fetch step for the homepage probe", async () => {
    const html = "<html/>";
    const { fetchImpl } = makeFetchStub({
      "https://shape.test/": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html" },
        body: html,
      },
    });
    const ctx = createScanContext({ url: "https://shape.test", fetchImpl });
    const result = await checkWebMcp(ctx);
    const actions = result.evidence.map((s: EvidenceStep) => s.action);
    expect(actions[0]).toBe("fetch");
    expect(actions[actions.length - 1]).toBe("conclude");
  });
});
