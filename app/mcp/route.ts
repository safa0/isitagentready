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
  mcpRateLimiter,
  extractClientIp,
  rateLimitHeaders,
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

function errorResponse(
  message: string,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

/**
 * Clone a Response with additional headers. Needed because the MCP SDK's
 * transport.handleRequest builds the Response object itself and we can't
 * pass headers through at construction time.
 */
async function withExtraHeaders(
  res: Response,
  extraHeaders: Record<string, string>,
): Promise<Response> {
  const headers = new Headers(res.headers);
  for (const [key, value] of Object.entries(extraHeaders)) {
    headers.set(key, value);
  }
  const body = await res.arrayBuffer();
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

export async function POST(req: Request): Promise<Response> {
  // 1. Rate limit (MCP-specific bucket — tighter cap than REST).
  const ip = extractClientIp(req);
  const now = Date.now();
  if (!mcpRateLimiter.check(ip, now)) {
    return errorResponse(
      "Too many requests. Please retry later.",
      429,
      rateLimitHeaders(mcpRateLimiter.snapshot(ip, now)),
    );
  }
  const limitHeaders = rateLimitHeaders(mcpRateLimiter.snapshot(ip, now));

  // 2. Stateless: new server + transport per request.
  const server = createServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  try {
    await server.connect(transport);
    const res = await transport.handleRequest(req);
    return await withExtraHeaders(res, limitHeaders);
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
        headers: { "content-type": "application/json", ...limitHeaders },
      },
    );
  }
}

// Reject non-POST via the standard Next.js method negotiation: exporting only
// POST means other verbs auto-return 405 Method Not Allowed.
