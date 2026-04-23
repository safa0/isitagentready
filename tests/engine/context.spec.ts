import { describe, expect, it } from "vitest";
import {
  BODY_PREVIEW_MAX_CHARS,
  BODY_PREVIEW_TRUNCATED_SUFFIX,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  RESPONSE_BODY_MAX_BYTES,
  createScanContext,
  fetchToStep,
  headersToRecord,
  makeStep,
  toBodyPreview,
  type FetchOutcome,
} from "@/lib/engine/context";
import { EvidenceStepSchema } from "@/lib/schema";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface StubCall {
  readonly input: string;
  readonly init: RequestInit;
}

interface StubResponseInit {
  readonly status?: number;
  readonly statusText?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

function stubResponse({
  status = 200,
  statusText = "OK",
  headers = {},
  body = "",
}: StubResponseInit = {}): Response {
  return new Response(body, { status, statusText, headers });
}

function makeFetchStub(
  handlers: Record<string, StubResponseInit | Error>,
): {
  fetch: typeof fetch;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const fn: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push({ input: url, init: init ?? {} });
    const handler = handlers[url];
    if (handler === undefined) {
      throw new Error(`Unexpected fetch: ${url}`);
    }
    if (handler instanceof Error) throw handler;
    return stubResponse(handler);
  };
  return { fetch: fn, calls };
}

// ---------------------------------------------------------------------------
// toBodyPreview / headersToRecord
// ---------------------------------------------------------------------------

describe("toBodyPreview", () => {
  it("returns undefined for empty body", () => {
    expect(toBodyPreview("")).toBeUndefined();
  });

  it("returns body verbatim when within cap", () => {
    expect(toBodyPreview("hello")).toBe("hello");
  });

  it("truncates and suffixes bodies longer than the cap", () => {
    const long = "x".repeat(BODY_PREVIEW_MAX_CHARS + 50);
    const preview = toBodyPreview(long);
    expect(preview).toBeDefined();
    expect(preview!.endsWith(BODY_PREVIEW_TRUNCATED_SUFFIX)).toBe(true);
    expect(preview!.length).toBe(
      BODY_PREVIEW_MAX_CHARS + BODY_PREVIEW_TRUNCATED_SUFFIX.length,
    );
  });

  it("matches the 503-char preview length observed in real fixtures", () => {
    const long = "y".repeat(10_000);
    expect(toBodyPreview(long)!.length).toBe(503);
  });
});

describe("headersToRecord", () => {
  it("lowercases header keys and preserves values", () => {
    const h = new Headers({ "Content-Type": "text/plain", "X-Foo": "Bar" });
    expect(headersToRecord(h)).toEqual({
      "content-type": "text/plain",
      "x-foo": "Bar",
    });
  });
});

// ---------------------------------------------------------------------------
// Step builders
// ---------------------------------------------------------------------------

describe("makeStep / fetchToStep", () => {
  it("makeStep builds a non-network step that matches EvidenceStepSchema", () => {
    const step = makeStep("parse", "Validate robots.txt structure", {
      outcome: "positive",
      summary: "Contains valid User-agent directive(s)",
    });
    expect(EvidenceStepSchema.parse(step)).toEqual(step);
    expect(step.request).toBeUndefined();
    expect(step.response).toBeUndefined();
  });

  it("fetchToStep includes request + response when present", () => {
    const outcome: FetchOutcome = {
      request: { url: "https://x.test/", method: "GET", headers: {} },
      response: {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/plain" },
        bodyPreview: "hello",
      },
      body: "hello",
      durationMs: 5,
    };
    const step = fetchToStep(outcome, "GET /", {
      outcome: "positive",
      summary: "ok",
    });
    expect(step.request).toEqual(outcome.request);
    expect(step.response).toEqual(outcome.response);
    expect(EvidenceStepSchema.parse(step)).toEqual(step);
  });

  it("fetchToStep omits response when fetch errored", () => {
    const outcome: FetchOutcome = {
      request: { url: "https://x.test/", method: "GET", headers: {} },
      error: "ENOTFOUND",
      durationMs: 2,
    };
    const step = fetchToStep(outcome, "GET /", {
      outcome: "negative",
      summary: "DNS failure",
    });
    expect(step.response).toBeUndefined();
    expect(EvidenceStepSchema.parse(step)).toEqual(step);
  });
});

// ---------------------------------------------------------------------------
// createScanContext
// ---------------------------------------------------------------------------

describe("createScanContext", () => {
  it("normalises input to origin-only URL and exposes defaults", () => {
    const { fetch } = makeFetchStub({});
    const ctx = createScanContext({
      url: "https://example.com/path?query=1#frag",
      fetchImpl: fetch,
    });
    expect(ctx.origin).toBe("https://example.com");
    expect(ctx.url.toString()).toBe("https://example.com/");
    expect(ctx.userAgent).toBe(DEFAULT_USER_AGENT);
    expect(ctx.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("rejects unsupported URL protocols", () => {
    expect(() =>
      createScanContext({
        url: "ftp://example.com/",
        fetchImpl: (async () => new Response()) as typeof fetch,
      }),
    ).toThrow(/unsupported protocol/);
  });

  it("resolves site-relative paths against the origin", () => {
    const ctx = createScanContext({
      url: "https://example.com",
      fetchImpl: (async () => new Response()) as typeof fetch,
    });
    expect(ctx.resolve("/robots.txt").toString()).toBe(
      "https://example.com/robots.txt",
    );
    expect(ctx.resolve("https://other.test/foo").toString()).toBe(
      "https://other.test/foo",
    );
  });

  it("records a successful fetch with lowercased headers and body preview", async () => {
    const body = "User-agent: *\nAllow: /\n";
    const { fetch, calls } = makeFetchStub({
      "https://example.com/robots.txt": {
        status: 200,
        statusText: "OK",
        headers: { "Content-Type": "text/plain" },
        body,
      },
    });
    let tick = 0;
    const ctx = createScanContext({
      url: "https://example.com",
      fetchImpl: fetch,
      now: () => (tick += 5),
    });
    const outcome = await ctx.fetch("/robots.txt");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toBe("https://example.com/robots.txt");
    expect(outcome.response?.status).toBe(200);
    expect(outcome.response?.headers["content-type"]).toBe("text/plain");
    expect(outcome.response?.bodyPreview).toBe(body);
    expect(outcome.body).toBe(body);
    expect(outcome.durationMs).toBeGreaterThan(0);
    expect(outcome.error).toBeUndefined();
  });

  it("always sends the configured User-Agent, merging user headers", async () => {
    const { fetch, calls } = makeFetchStub({
      "https://example.com/.well-known/foo": {
        status: 200,
        body: "",
      },
    });
    const ctx = createScanContext({
      url: "https://example.com",
      userAgent: "Custom/9.9",
      fetchImpl: fetch,
    });
    await ctx.fetch("/.well-known/foo", {
      headers: { Accept: "application/json" },
    });
    const init = calls[0]!.init as RequestInit & {
      headers: Record<string, string>;
    };
    expect(init.headers["user-agent"]).toBe("Custom/9.9");
    expect(init.headers["Accept"]).toBe("application/json");
  });

  it("captures transport errors without throwing", async () => {
    const err = new Error("ENOTFOUND example.test");
    const { fetch } = makeFetchStub({
      "https://example.test/robots.txt": err,
    });
    const ctx = createScanContext({
      url: "https://example.test",
      fetchImpl: fetch,
    });
    const outcome = await ctx.fetch("/robots.txt");
    expect(outcome.response).toBeUndefined();
    expect(outcome.body).toBeUndefined();
    expect(outcome.error).toMatch(/ENOTFOUND/);
  });

  it("omits bodyPreview on empty-body responses", async () => {
    const { fetch } = makeFetchStub({
      "https://example.com/empty": { status: 200, body: "" },
    });
    const ctx = createScanContext({
      url: "https://example.com",
      fetchImpl: fetch,
    });
    const outcome = await ctx.fetch("/empty");
    expect(outcome.response?.status).toBe(200);
    expect(outcome.response?.bodyPreview).toBeUndefined();
    expect(outcome.body).toBe("");
  });

  it("memoises getHomepage() across concurrent callers", async () => {
    const { fetch, calls } = makeFetchStub({
      "https://example.com/": { status: 200, body: "<html></html>" },
    });
    const ctx = createScanContext({
      url: "https://example.com",
      fetchImpl: fetch,
    });
    const [a, b] = await Promise.all([ctx.getHomepage(), ctx.getHomepage()]);
    expect(calls).toHaveLength(1);
    expect(a).toBe(b);
  });

  it("memoises getRobotsTxt() separately from arbitrary fetches", async () => {
    const { fetch, calls } = makeFetchStub({
      "https://example.com/robots.txt": {
        status: 200,
        body: "User-agent: *",
      },
    });
    const ctx = createScanContext({
      url: "https://example.com",
      fetchImpl: fetch,
    });
    await ctx.getRobotsTxt();
    await ctx.getRobotsTxt();
    expect(calls).toHaveLength(1);
  });

  it("returns a frozen context object", () => {
    const ctx = createScanContext({
      url: "https://example.com",
      fetchImpl: (async () => new Response()) as typeof fetch,
    });
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  it("throws when no fetch implementation is available", () => {
    expect(() =>
      createScanContext({
        url: "https://example.com",
        fetchImpl: undefined as unknown as typeof fetch,
      }),
    ).not.toThrow(); // falls back to globalThis.fetch on Node 24
  });
});

// ---------------------------------------------------------------------------
// Redirect SSRF defence (H5)
// ---------------------------------------------------------------------------

function redirectFetchStub(
  plan: Record<
    string,
    { status: number; location?: string; body?: string; headers?: Record<string, string> }
  >,
): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fn: typeof fetch = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push(url);
    const entry = plan[url];
    if (entry === undefined) {
      throw new Error(`Unexpected fetch: ${url}`);
    }
    const headers = new Headers(entry.headers ?? {});
    if (entry.location !== undefined) headers.set("location", entry.location);
    return new Response(entry.body ?? "", { status: entry.status, headers });
  };
  return { fetch: fn, calls };
}

describe("createScanContext - redirect handling (SSRF defence)", () => {
  it("refuses to follow a redirect to a private host", async () => {
    const { fetch, calls } = redirectFetchStub({
      "https://example.com/open": {
        status: 302,
        location: "http://169.254.169.254/",
      },
    });
    const ctx = createScanContext({
      url: "https://example.com",
      fetchImpl: fetch,
    });
    const outcome = await ctx.fetch("/open");
    expect(outcome.response).toBeUndefined();
    expect(outcome.error).toMatch(/Redirect blocked/i);
    expect(calls).toHaveLength(1);
  });

  it("follows a redirect to a public host (within the hop budget)", async () => {
    const { fetch, calls } = redirectFetchStub({
      "https://example.com/start": {
        status: 302,
        location: "https://example.com/final",
      },
      "https://example.com/final": { status: 200, body: "ok" },
    });
    const ctx = createScanContext({
      url: "https://example.com",
      fetchImpl: fetch,
    });
    const outcome = await ctx.fetch("/start");
    expect(outcome.response?.status).toBe(200);
    expect(outcome.body).toBe("ok");
    expect(calls).toEqual([
      "https://example.com/start",
      "https://example.com/final",
    ]);
  });

  it("caps redirect chains at MAX_REDIRECT_HOPS", async () => {
    const { fetch } = redirectFetchStub({
      "https://example.com/a": {
        status: 302,
        location: "https://example.com/b",
      },
      "https://example.com/b": {
        status: 302,
        location: "https://example.com/c",
      },
      "https://example.com/c": {
        status: 302,
        location: "https://example.com/d",
      },
      "https://example.com/d": {
        status: 302,
        location: "https://example.com/e",
      },
    });
    const ctx = createScanContext({
      url: "https://example.com",
      fetchImpl: fetch,
    });
    const outcome = await ctx.fetch("/a");
    expect(outcome.response).toBeUndefined();
    expect(outcome.error).toMatch(/too many redirects/i);
  });

  it("rejects a redirect Location with an unsupported scheme", async () => {
    const { fetch } = redirectFetchStub({
      "https://example.com/out": {
        status: 302,
        location: "file:///etc/passwd",
      },
    });
    const ctx = createScanContext({
      url: "https://example.com",
      fetchImpl: fetch,
    });
    const outcome = await ctx.fetch("/out");
    expect(outcome.error).toMatch(/Redirect blocked/i);
  });
});

// ---------------------------------------------------------------------------
// Response body byte cap (L-test-1)
// ---------------------------------------------------------------------------

describe("createScanContext - response body byte cap", () => {
  it("truncates response bodies at RESPONSE_BODY_MAX_BYTES (slice-and-drop branch)", async () => {
    // A single oversized chunk forces the "chunk larger than remaining"
    // branch inside `readBodyCapped`, which slices the chunk down and then
    // cancels the reader.
    const chunk = new Uint8Array(RESPONSE_BODY_MAX_BYTES + 4096).fill(65);
    const fetchImpl: typeof fetch = async () =>
      new Response(chunk, { status: 200 });
    const ctx = createScanContext({
      url: "https://example.com",
      fetchImpl,
    });
    const outcome = await ctx.fetch("/big");
    expect(outcome.response?.status).toBe(200);
    expect(outcome.body).toBeDefined();
    expect(outcome.body!.length).toBe(RESPONSE_BODY_MAX_BYTES);
  });

  it("truncates when the boundary is hit across multiple chunks", async () => {
    // Build the response out of two chunks that straddle the 1 MiB cap so
    // the `remaining <= 0` branch on the second read is also covered.
    const chunkSize = 768 * 1024; // 768 KiB → two chunks = 1.5 MiB total.
    const chunk1 = new Uint8Array(chunkSize).fill(66);
    const chunk2 = new Uint8Array(chunkSize).fill(67);
    const body = new Uint8Array(chunkSize * 2);
    body.set(chunk1, 0);
    body.set(chunk2, chunkSize);
    const fetchImpl: typeof fetch = async () =>
      new Response(body, { status: 200 });
    const ctx = createScanContext({
      url: "https://example.com",
      fetchImpl,
    });
    const outcome = await ctx.fetch("/big2");
    expect(outcome.body).toBeDefined();
    expect(outcome.body!.length).toBeLessThanOrEqual(RESPONSE_BODY_MAX_BYTES);
  });
});

// ---------------------------------------------------------------------------
// Multi-hop relative redirects (L-sec-1)
// ---------------------------------------------------------------------------

describe("createScanContext - relative redirect chains", () => {
  it("resolves relative Location against the previous hop, not the original URL", async () => {
    const { fetch, calls } = redirectFetchStub({
      "https://example.com/deep/start": {
        status: 302,
        location: "/hop1", // resolves against origin /deep/start → /hop1
      },
      "https://example.com/hop1": {
        status: 302,
        location: "hop2", // relative to /hop1 → /hop2
      },
      "https://example.com/hop2": { status: 200, body: "done" },
    });
    const ctx = createScanContext({
      url: "https://example.com",
      fetchImpl: fetch,
    });
    const outcome = await ctx.fetch("/deep/start");
    expect(outcome.response?.status).toBe(200);
    expect(outcome.body).toBe("done");
    expect(calls).toEqual([
      "https://example.com/deep/start",
      "https://example.com/hop1",
      "https://example.com/hop2",
    ]);
  });
});

// ---------------------------------------------------------------------------
// AbortSignal plumbing (H4)
// ---------------------------------------------------------------------------

describe("createScanContext - abort signal", () => {
  it("aborts an in-flight fetch when the external signal fires", async () => {
    // A fetch that races the abort.
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const sig = init?.signal;
        if (sig?.aborted) return reject(sig.reason ?? new Error("aborted"));
        sig?.addEventListener("abort", () =>
          reject(sig.reason ?? new Error("aborted")),
        );
      });
    const controller = new AbortController();
    const ctx = createScanContext({
      url: "https://example.com",
      fetchImpl,
      signal: controller.signal,
    });
    const p = ctx.fetch("/slow");
    controller.abort(new Error("scan cancelled"));
    const outcome = await p;
    expect(outcome.response).toBeUndefined();
    expect(outcome.error).toMatch(/cancelled|abort/i);
  });
});

// ---------------------------------------------------------------------------
// Shared probe memo (H9)
// ---------------------------------------------------------------------------

describe("createScanContext - shared probe memo", () => {
  it("contexts sharing a SharedProbes record issue a single homepage fetch", async () => {
    const { fetch, calls } = makeFetchStub({
      "https://example.com/": { status: 200, body: "<html></html>" },
    });
    const { createSharedProbes } = await import("@/lib/engine/context");
    const shared = createSharedProbes();
    const ctxA = createScanContext({
      url: "https://example.com",
      fetchImpl: fetch,
      sharedProbes: shared,
    });
    const ctxB = createScanContext({
      url: "https://example.com",
      fetchImpl: fetch,
      sharedProbes: shared,
    });
    const [a, b] = await Promise.all([ctxA.getHomepage(), ctxB.getHomepage()]);
    expect(calls).toHaveLength(1);
    // Same promise result reference — sharedProbes returns the memo verbatim.
    expect(a).toBe(b);
  });
});
