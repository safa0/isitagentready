/**
 * Specs for the `webMcp` check.
 *
 * Reference: `research/FINDINGS.md` §3, §9, §13 (gaps).
 *
 * webMcp has no structural oracle coverage by design — the reference scanner
 * uses a headless Chromium instance to evaluate page JS at runtime and detect
 * `navigator.modelContext.{registerTool,provideContext}` calls live. A static
 * scanner cannot match the Chromium-based oracle's evidence shape, and a
 * trivial "every fixture exits cleanly" loop would be tautological (it would
 * only assert the final `status`+`message` against an identical stubbed
 * empty-HTML homepage for every site). Instead, we exercise the static
 * fallback directly against hand-rolled fixtures below: pass paths (inline +
 * linked), the SSRF guard, fail paths, and robustness cases.
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

import { makeFetchStub } from "./_helpers/oracle";
import { createScanContext } from "@/lib/engine/context";
import { CheckResultSchema, type EvidenceStep } from "@/lib/schema";

import { checkWebMcp } from "@/lib/engine/checks/web-mcp";

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
    expect(CheckResultSchema.safeParse(result).success).toBe(true);
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
    expect(CheckResultSchema.safeParse(result).success).toBe(true);
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
    expect(CheckResultSchema.safeParse(result).success).toBe(true);
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

  it("skips same-host-different-port scripts (distinct origin per RFC 6454)", async () => {
    const html = `<html><body>
      <script src="https://guard.test:8443/x.js"></script>
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
    expect(
      calls.some((u) => u.startsWith("https://guard.test:8443/")),
    ).toBe(false);
    const skipStep = result.evidence.find((s) =>
      s.finding.summary.toLowerCase().includes("cross-origin"),
    );
    expect(skipStep).toBeDefined();
  });

  it("skips protocol-relative script URLs that resolve to a different host", async () => {
    const html = `<html><body>
      <script src="//cdn.evil.com/x.js"></script>
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
    // Protocol-relative URL resolves to https://cdn.evil.com/x.js — must skip.
    expect(calls.some((u) => u.startsWith("https://cdn.evil.com/"))).toBe(
      false,
    );
    const skipStep = result.evidence.find((s) =>
      s.finding.summary.toLowerCase().includes("cross-origin"),
    );
    expect(skipStep).toBeDefined();
  });

  it("skips protocol-relative script URLs with userinfo spoofing the origin host", async () => {
    // Sanity check: the userinfo form really does resolve to evil.com — if this
    // invariant ever breaks, the test below needs to be revisited.
    expect(
      new URL("//guard.test@evil.com/x.js", "https://guard.test/").origin,
    ).toBe("https://evil.com");

    const html = `<html><body>
      <script src="//guard.test@evil.com/x.js"></script>
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
    // The attacker host must never be contacted, nor the raw userinfo URL.
    expect(calls.some((u) => u.includes("evil.com"))).toBe(false);
    expect(calls.some((u) => u.includes("guard.test@"))).toBe(false);
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
    expect(CheckResultSchema.safeParse(result).success).toBe(true);
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

  it("regex limitation: quoted '>' in script attribute still yields a match on the truncated body (known gap, locked for review)", async () => {
    // INLINE_SCRIPT_REGEX uses `[^>]*` for the opening tag, so a quoted '>' in
    // an attribute terminates the attribute list early — see the iter-2
    // comment in lib/engine/checks/web-mcp.ts. For this exact input the
    // truncated body ("b\">navigator.modelContext.registerTool({})") still
    // contains the API signature, so the scan currently *passes*. Locked here
    // so any future regex change that shifts this behaviour (in either
    // direction) must be reviewed explicitly.
    const html = `<script data-x="a>b">navigator.modelContext.registerTool({})</script>`;
    const { fetchImpl } = makeFetchStub({
      "https://regex-edge.test/": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html" },
        body: html,
      },
    });
    const ctx = createScanContext({ url: "https://regex-edge.test", fetchImpl });
    const result = await checkWebMcp(ctx);
    expect(result.status).toBe("pass");
    expect(CheckResultSchema.safeParse(result).success).toBe(true);
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
    // Exactly 20 script fetches (the implementation cap) — no more, no fewer.
    const scriptCalls = calls.filter((u) => /\/s\d+\.js$/.test(u));
    expect(scriptCalls).toHaveLength(20);
    // Negative assertion: scripts s20..s24 must never be fetched.
    for (let i = 20; i < 25; i++) {
      expect(calls.some((u) => u.endsWith(`/s${i}.js`))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Evidence shape
// ---------------------------------------------------------------------------

describe("webMcp — robustness", () => {
  it("records the fallback summary when the homepage transport error has no message", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://silent.test/": new Error(""),
    });
    const ctx = createScanContext({ url: "https://silent.test", fetchImpl });
    const result = await checkWebMcp(ctx);
    expect(result.status).toBe("fail");
    const fetchStep = result.evidence.find((s) => s.action === "fetch")!;
    expect(fetchStep.finding.summary).toBe(
      "Homepage request failed with no response",
    );
  });

  it("records a transport-error summary when a linked same-origin script errors", async () => {
    const html = `<html><body>
      <script src="/broken.js"></script>
    </body></html>`;
    const { fetchImpl } = makeFetchStub({
      "https://scripterr.test/": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html" },
        body: html,
      },
      "https://scripterr.test/broken.js": new Error("ECONNRESET"),
    });
    const ctx = createScanContext({ url: "https://scripterr.test", fetchImpl });
    const result = await checkWebMcp(ctx);
    expect(result.status).toBe("fail");
    const errStep = result.evidence.find((s) =>
      s.finding.summary.toLowerCase().includes("fetch failed"),
    );
    expect(errStep).toBeDefined();
  });

  it("records a parse-error step when a script src URL is unparseable", async () => {
    const html = `<html><body>
      <script src="http://"></script>
      <script src="/ok.js"></script>
    </body></html>`;
    const { fetchImpl } = makeFetchStub({
      "https://badsrc.test/": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html" },
        body: html,
      },
      "https://badsrc.test/ok.js": {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/javascript" },
        body: "navigator.modelContext.registerTool({});",
      },
    });
    const ctx = createScanContext({ url: "https://badsrc.test", fetchImpl });
    const result = await checkWebMcp(ctx);
    // The unparseable entry is recorded, and the good one still passes.
    expect(result.status).toBe("pass");
    expect(CheckResultSchema.safeParse(result).success).toBe(true);
    const parseErr = result.evidence.find((s) =>
      s.finding.summary.toLowerCase().includes("could not parse script url"),
    );
    expect(parseErr).toBeDefined();
  });
});

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
