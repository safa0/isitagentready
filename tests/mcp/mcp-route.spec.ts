/**
 * Failing specs for `app/mcp/route.ts` — POST /mcp Streamable HTTP.
 */

import { describe, expect, it } from "vitest";

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
    expect([400, 406, 415, 422, 500]).toContain(res.status);
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
});
