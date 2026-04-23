/**
 * POST /mcp — Model Context Protocol endpoint (Streamable HTTP, stateless).
 *
 * Exposes a single `scan_site` tool that delegates to the engine's `runScan`.
 * Stateless mode matches Vercel Fluid Compute's ephemeral request model.
 *
 * TODO(phase-later): add OAuth-based auth (RFC 8414 + RFC 9728). For now
 * this endpoint is unauthenticated — parity with the reference scanner.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

import { runScan } from "@/lib/engine";
import {
  normaliseScanUrl,
  assertPublicUrl,
  ScanUrlError,
} from "@/lib/engine/security";
import { ProfileSchema, CheckIdSchema } from "@/lib/schema";

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

function createServer(): McpServer {
  const server = new McpServer({
    name: "Agent Readiness Scanner",
    version: "1.0.0",
  });

  server.registerTool(
    "scan_site",
    {
      title: "Scan Site",
      description:
        "Scan a public URL for agent-readiness signals and return the full scan report.",
      inputSchema: {
        url: z.string().url(),
        profile: ProfileSchema.optional(),
        enabledChecks: z.array(CheckIdSchema).optional(),
      },
    },
    async ({ url, profile, enabledChecks }) => {
      try {
        const parsed = normaliseScanUrl(url);
        assertPublicUrl(parsed);
      } catch (err) {
        const message =
          err instanceof ScanUrlError ? err.message : "Invalid URL.";
        return {
          isError: true,
          content: [{ type: "text", text: message }],
        };
      }
      const result = await runScan(url, { profile, enabledChecks });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: Request): Promise<Response> {
  // Stateless: new server + transport per request.
  const server = createServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : "MCP handler failed.";
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32603, message },
        id: null,
      }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      },
    );
  }
}

// Reject non-POST via the standard Next.js method negotiation: exporting only
// POST means other verbs auto-return 405 Method Not Allowed.
