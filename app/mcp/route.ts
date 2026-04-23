/**
 * POST /mcp — Model Context Protocol endpoint (Streamable HTTP, stateless).
 *
 * Exposes a single `scan_site` tool that delegates to the engine's `runScan`.
 * Stateless mode matches Vercel Fluid Compute's ephemeral request model.
 *
 * Security:
 *   - Rate-limited per caller IP via the shared rate limiter (same bucket
 *     as `/api/scan`).
 *   - Transport-level errors are mapped to a generic "Internal MCP error"
 *     so we never leak internal exception messages.
 *   - SSRF validation lives in `runScan`; tool invocations catch
 *     `ScanUrlError` and report it as a tool error.
 *
 * TODO(phase-later): add OAuth-based auth (RFC 8414 + RFC 9728). For now
 * this endpoint is unauthenticated — parity with the reference scanner.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

import { runScan, ScanUrlError } from "@/lib/engine";
import { ProfileSchema, CheckIdSchema } from "@/lib/schema";
import {
  defaultRateLimiter,
  extractClientIp,
} from "@/lib/api/rate-limiter";

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Input schema for the `scan_site` tool. Wrapped in `z.object(...)` per the
 * MCP SDK contract (the SDK expects a ZodObject, not a plain field record).
 */
const ScanSiteInputSchema = z.object({
  url: z.string().url().max(2048),
  profile: ProfileSchema.optional(),
  enabledChecks: z.array(CheckIdSchema).max(19).optional(),
});

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
      inputSchema: ScanSiteInputSchema.shape,
    },
    async ({ url, profile, enabledChecks }) => {
      try {
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
      } catch (err) {
        if (err instanceof ScanUrlError) {
          return {
            isError: true,
            content: [{ type: "text", text: err.message }],
          };
        }
        return {
          isError: true,
          content: [{ type: "text", text: "scan_site failed." }],
        };
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

function errorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function POST(req: Request): Promise<Response> {
  // 1. Rate limit.
  const ip = extractClientIp(req);
  if (!defaultRateLimiter.check(ip, Date.now())) {
    return errorResponse("Too many requests. Please retry later.", 429);
  }

  // 2. Stateless: new server + transport per request.
  const server = createServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(req);
  } catch {
    // Static error envelope — never leak the internal message.
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal MCP error" },
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
