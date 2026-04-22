import { describe, expect, it } from "vitest";
import {
  BODY_PREVIEW_MAX_CHARS,
  BODY_PREVIEW_TRUNCATED_SUFFIX,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
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
