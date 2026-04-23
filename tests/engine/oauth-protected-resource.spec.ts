/**
 * Oracle-driven tests for checkOauthProtectedResource.
 *
 * Spec (FINDINGS §3 / §9):
 *   Probe: GET /              (to sniff WWW-Authenticate)
 *          GET /.well-known/oauth-protected-resource
 *   Pass: 200 JSON with a `resource` field.
 *
 * Oracle observations across 5 fixtures (all 5 fail):
 *   - 3 evidence steps in each: homepage fetch + well-known fetch + conclude.
 *   - The oracle captures resolution order which varies per fixture. Our
 *     implementation now emits in fixed DISPATCH order (homepage then
 *     well-known), so we compare by label (order-independent for non-terminal
 *     steps) and still assert the conclusion is last.
 */

import { describe, expect, it } from "vitest";

import {
  ALL_SITES,
  expectCheckMatchesOracle,
  makeFetchStub,
  runCheckAgainstOracle,
  type OracleCheckLike,
} from "./_helpers/oracle";
import { createScanContext } from "@/lib/engine/context";
import { CheckResultSchema } from "@/lib/schema";

import { checkOauthProtectedResource } from "@/lib/engine/checks/oauth-protected-resource";

// ---------------------------------------------------------------------------
// Oracle round-trip
// ---------------------------------------------------------------------------

function getOracleEntry(raw: unknown): OracleCheckLike {
  return (
    raw as {
      checks: { discovery: { oauthProtectedResource: OracleCheckLike } };
    }
  ).checks.discovery.oauthProtectedResource;
}

describe("checkOauthProtectedResource — oracle fixtures", () => {
  for (const site of ALL_SITES) {
    it(`matches the ${site} oracle`, async () => {
      const { result, oracle, origin, calls } = await runCheckAgainstOracle({
        site,
        getOracleEntry,
        runCheck: checkOauthProtectedResource,
      });

      expect(() => CheckResultSchema.parse(result)).not.toThrow();
      expectCheckMatchesOracle(result, oracle, { evidenceOrder: "by-label" });

      // Dispatch order: homepage first, well-known second.
      expect(result.evidence[0]!.label).toBe("GET /");
      expect(result.evidence[1]!.label).toBe(
        "GET /.well-known/oauth-protected-resource",
      );
      expect(result.evidence[2]!.action).toBe("conclude");

      expect(calls).toEqual(
        expect.arrayContaining([
          `${origin}/`,
          `${origin}/.well-known/oauth-protected-resource`,
        ]),
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

const JSON_HEADERS = { "content-type": "application/json" };

describe("checkOauthProtectedResource — edge cases", () => {
  it("passes when well-known returns 200 JSON with `resource` field", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://example.com/": {
        status: 200,
        headers: { "content-type": "text/html" },
      },
      "https://example.com/.well-known/oauth-protected-resource": {
        status: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({
          resource: "https://example.com",
          authorization_servers: ["https://auth.example.com"],
        }),
      },
    });
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkOauthProtectedResource(ctx);
    expect(result.status).toBe("pass");
  });

  it("fails when well-known returns 200 JSON but no `resource` field", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://example.com/": {
        status: 200,
        headers: { "content-type": "text/html" },
      },
      "https://example.com/.well-known/oauth-protected-resource": {
        status: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({ foo: "bar" }),
      },
    });
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkOauthProtectedResource(ctx);
    expect(result.status).toBe("fail");
  });

  it("fails when well-known returns 404", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://example.com/": {
        status: 200,
        headers: { "content-type": "text/html" },
      },
      "https://example.com/.well-known/oauth-protected-resource": {
        status: 404,
        headers: {},
      },
    });
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkOauthProtectedResource(ctx);
    expect(result.status).toBe("fail");
  });

  it("fails gracefully on transport errors to well-known", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (url.includes("/.well-known/oauth-protected-resource")) {
        throw new Error("ECONNRESET");
      }
      // Homepage (and any other non-well-known request) returns a normal 200.
      return new Response("", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    };
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkOauthProtectedResource(ctx);
    expect(result.status).toBe("fail");
    // The well-known fetch must have failed (transport error).
    const wellKnownStep = result.evidence.find(
      (s) =>
        s.action === "fetch" &&
        s.label === "GET /.well-known/oauth-protected-resource",
    );
    expect(wellKnownStep?.finding.outcome).toBe("negative");
  });

  it("records a positive homepage finding when WWW-Authenticate is present", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://example.com/": {
        status: 401,
        statusText: "Unauthorized",
        headers: {
          "www-authenticate": 'Bearer resource="https://example.com"',
        },
      },
      "https://example.com/.well-known/oauth-protected-resource": {
        status: 404,
        headers: {},
      },
    });
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkOauthProtectedResource(ctx);
    // Still fails (well-known 404); but homepage step must be positive.
    expect(result.status).toBe("fail");
    const homepageStep = result.evidence.find(
      (s) => s.action === "fetch" && s.label === "GET /",
    );
    expect(homepageStep?.finding.outcome).toBe("positive");
  });

  it("fails when well-known returns 200 but not JSON", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://example.com/": {
        status: 200,
        headers: { "content-type": "text/html" },
      },
      "https://example.com/.well-known/oauth-protected-resource": {
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<html></html>",
      },
    });
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkOauthProtectedResource(ctx);
    expect(result.status).toBe("fail");
  });

  it("preserves dispatch order (homepage, then well-known) even when well-known resolves first", async () => {
    // Delay homepage so well-known resolves first; evidence must still reflect
    // dispatch order (homepage at index 0).
    const fetchImpl: typeof fetch = async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (url === "https://example.com/") {
        await new Promise((r) => setTimeout(r, 20));
        return new Response("", { status: 200 });
      }
      return new Response("", { status: 404 });
    };
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkOauthProtectedResource(ctx);
    expect(result.evidence[0]!.label).toBe("GET /");
    expect(result.evidence[1]!.label).toBe(
      "GET /.well-known/oauth-protected-resource",
    );
  });
});
