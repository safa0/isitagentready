/**
 * Failing specs for `app/mcp/route.ts` — POST /mcp Streamable HTTP.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultRateLimiter, mcpRateLimiter } from "@/lib/api/rate-limiter";

// Mock the engine so tools/call tests are deterministic.
vi.mock("@/lib/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/engine")>();
  return {
    ...actual,
    runScan: vi.fn(),
  };
});

beforeEach(() => {
  defaultRateLimiter.reset();
  mcpRateLimiter.reset();
});

afterEach(() => {
  vi.clearAllMocks();
});

function mcpRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

// We import via dynamic import so the route can be implemented later without
// blocking module resolution in the test file.
describe("POST /mcp", () => {
  it("exposes a POST handler", async () => {
    const mod = await import("@/app/mcp/route");
    expect(typeof mod.POST).toBe("function");
  });

  it("rejects non-JSON bodies with a JSON-RPC-style error or 4xx", async () => {
    const { POST } = await import("@/app/mcp/route");
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not json",
    });
    const res = await POST(req);
    expect([400, 406, 415, 422]).toContain(res.status);
  });

  it("responds to MCP initialize with serverInfo", async () => {
    const { POST } = await import("@/app/mcp/route");
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    };
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    });
    const res = await POST(req);
    // Either JSON or SSE. Either way the response must be 200.
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Agent Readiness Scanner");
  });

  it("rate-limits requests from the same caller (H8)", async () => {
    const { POST } = await import("@/app/mcp/route");
    let last429 = false;
    for (let i = 0; i < 12; i++) {
      const res = await POST(
        mcpRequest(
          { jsonrpc: "2.0", id: i, method: "initialize", params: {
            protocolVersion: "2025-03-26", capabilities: {},
            clientInfo: { name: "test", version: "1.0" } } },
          { "x-forwarded-for": "7.7.7.7" },
        ),
      );
      if (res.status === 429) last429 = true;
    }
    expect(last429).toBe(true);
  });

  it("advertises the scan_site tool via tools/list", async () => {
    const { POST } = await import("@/app/mcp/route");
    // We need to initialize first in stateless mode (Streamable HTTP stateless
    // allows direct tools/list without sessions when the server is configured
    // stateless, but SDK may require init first). Try a direct tools/list.
    const body = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    };
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    });
    const res = await POST(req);
    // Accept either a 200 with tool listing or a session-required error. We
    // assert the status is a well-formed response.
    expect([200, 400]).toContain(res.status);
    const text = await res.text();
    // If 200, scan_site should appear in the payload.
    if (res.status === 200) {
      expect(text).toContain("scan_site");
    }
  });

  it("scan_site tools/call returns structured content on a valid URL (M10)", async () => {
    const mod = await import("@/lib/engine");
    const runScanMock = vi.mocked(mod.runScan);
    const fake: import("@/lib/schema").ScanResponse = {
      url: "https://ok.test/",
      scannedAt: new Date().toISOString(),
      level: 0,
      levelName: "Not Ready",
      // Reference the same shape used in the API test — minimal and schema-valid.
      checks: {
        discoverability: {
          robotsTxt: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
          sitemap: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
          linkHeaders: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
        },
        contentAccessibility: {
          markdownNegotiation: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
        },
        botAccessControl: {
          robotsTxtAiRules: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
          contentSignals: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
          webBotAuth: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
        },
        discovery: {
          apiCatalog: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
          oauthDiscovery: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
          oauthProtectedResource: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
          mcpServerCard: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
          a2aAgentCard: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
          agentSkills: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
          webMcp: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
        },
        commerce: {
          x402: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
          mpp: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
          ucp: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
          acp: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
          ap2: { status: "neutral" as const, message: "n", evidence: [], durationMs: 0 },
        },
      },
      nextLevel: null,
      isCommerce: false,
      commerceSignals: [],
    };
    runScanMock.mockResolvedValueOnce(fake);

    const { POST } = await import("@/app/mcp/route");
    const res = await POST(
      mcpRequest({
        jsonrpc: "2.0",
        id: 42,
        method: "tools/call",
        params: { name: "scan_site", arguments: { url: "https://ok.test/" } },
      }, { "x-forwarded-for": "198.51.100.80" }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    // Payload contains the stringified result with our sentinel URL.
    expect(text).toContain("ok.test");
  });

  it("scan_site tools/call returns isError on a generic engine failure", async () => {
    const mod = await import("@/lib/engine");
    const runScanMock = vi.mocked(mod.runScan);
    runScanMock.mockImplementationOnce(async () => {
      throw new Error("upstream went dark");
    });

    const { POST } = await import("@/app/mcp/route");
    const res = await POST(
      mcpRequest({
        jsonrpc: "2.0",
        id: 44,
        method: "tools/call",
        params: { name: "scan_site", arguments: { url: "https://dark.test/" } },
      }, { "x-forwarded-for": "198.51.100.82" }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("scan_site failed");
    // Error message must not leak internal state.
    expect(text).not.toContain("upstream went dark");
  });

  it("scan_site tools/call returns isError for a private-host URL (M10)", async () => {
    const mod = await import("@/lib/engine");
    const runScanMock = vi.mocked(mod.runScan);
    // Force the engine to surface the SSRF guard — the route forwards the
    // message back to the MCP client as an `isError` tool response.
    runScanMock.mockImplementationOnce(async () => {
      throw new mod.ScanUrlError("URL must resolve to a public host.");
    });

    const { POST } = await import("@/app/mcp/route");
    const res = await POST(
      mcpRequest({
        jsonrpc: "2.0",
        id: 43,
        method: "tools/call",
        params: { name: "scan_site", arguments: { url: "http://127.0.0.1" } },
      }, { "x-forwarded-for": "198.51.100.81" }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toMatch(/public host/i);
    // Tool-call error responses must surface isError on the content payload.
    expect(text).toMatch(/isError/);
  });
});
