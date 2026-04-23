/**
 * Oracle-driven tests for checkOauthDiscovery.
 *
 * Spec (FINDINGS §3 / §9):
 *   Probe: GET /.well-known/oauth-authorization-server
 *          GET /.well-known/openid-configuration
 *   Pass: Either returns 200 JSON with `issuer` + `authorization_endpoint`.
 *
 * Oracle observations across 5 fixtures:
 *   - vercel: both endpoints return 200 JSON → status "pass", 5 evidence steps
 *     (fetch + validate) * 2 + conclude.
 *   - cf-dev / cf / example / shopify: both 404 → status "fail", 3 steps
 *     (fetch + fetch + conclude).
 *
 * SYNTHESISED BODY (vercel) — the vercel oracle preserves response headers
 * but not `bodyPreview` for its OAuth/OIDC metadata endpoints. We reconstruct
 * a minimal valid payload from the oracle's own `details` fields so the
 * validator accepts it; one edge case below also feeds a captured real-world
 * Vercel payload through the check to assert full `details` parity without
 * synthesis.
 */

import { describe, expect, it } from "vitest";

import {
  ALL_SITES,
  expectCheckMatchesOracle,
  makeFetchStub,
  runCheckAgainstOracle,
  type OracleCheckLike,
  type OracleStepLike,
} from "./_helpers/oracle";
import { createScanContext } from "@/lib/engine/context";
import { CheckResultSchema } from "@/lib/schema";

import { checkOauthDiscovery } from "@/lib/engine/checks/oauth-discovery";

// ---------------------------------------------------------------------------
// Oracle round-trip
// ---------------------------------------------------------------------------

function getOracleEntry(raw: unknown): OracleCheckLike {
  return (raw as { checks: { discovery: { oauthDiscovery: OracleCheckLike } } })
    .checks.discovery.oauthDiscovery;
}

function synthesiseBody(
  step: OracleStepLike,
  oracle: OracleCheckLike,
): string | undefined {
  if (step.response === undefined) return undefined;
  const ct = (step.response.headers?.["content-type"] ?? "").toLowerCase();
  if (step.response.status !== 200 || !ct.includes("application/json")) {
    return undefined;
  }
  // Reconstruct JSON whose `validateMetadata` output matches the oracle's
  // recorded `details`. Without this the Cloudflare-truncated 200 responses
  // would fail validation during the round-trip.
  const details = oracle.details ?? {};
  const issuer =
    typeof details.issuer === "string"
      ? details.issuer
      : new URL(step.request!.url).origin;
  const grantTypes = Array.isArray(details.grantTypes)
    ? details.grantTypes
    : undefined;
  return JSON.stringify({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    jwks_uri: `${issuer}/.well-known/jwks`,
    ...(grantTypes !== undefined ? { grant_types_supported: grantTypes } : {}),
  });
}

describe("checkOauthDiscovery — oracle fixtures", () => {
  for (const site of ALL_SITES) {
    it(`matches the ${site} oracle`, async () => {
      const { result, oracle, origin, calls } = await runCheckAgainstOracle({
        site,
        getOracleEntry,
        runCheck: checkOauthDiscovery,
        synthesiseBody,
      });

      expect(() => CheckResultSchema.parse(result)).not.toThrow();
      // Dispatch order differs from oracle capture order on some fixtures
      // (vercel captured OIDC first; we dispatch oauth-authorization-server
      // first). Compare by label so the assertion is order-agnostic.
      expectCheckMatchesOracle(result, oracle, { evidenceOrder: "by-label" });

      // Both well-known paths must always be probed.
      expect(calls).toEqual(
        expect.arrayContaining([
          `${origin}/.well-known/oauth-authorization-server`,
          `${origin}/.well-known/openid-configuration`,
        ]),
      );

      // Dispatch order is deterministic: oauth-authorization-server first.
      expect(result.evidence[0]!.label).toBe(
        "GET /.well-known/oauth-authorization-server",
      );
      expect(result.evidence[result.evidence.length - 1]!.action).toBe(
        "conclude",
      );

      // Per-fixture details parity (when the oracle has them).
      if (oracle.details?.grantTypes !== undefined) {
        expect(result.details?.grantTypes).toEqual(oracle.details.grantTypes);
      }
      if (oracle.details?.hasTokenEndpoint !== undefined) {
        expect(result.details?.hasTokenEndpoint).toBe(
          oracle.details.hasTokenEndpoint,
        );
      }
      if (oracle.details?.hasJwksUri !== undefined) {
        expect(result.details?.hasJwksUri).toBe(oracle.details.hasJwksUri);
      }
      if (oracle.details?.source !== undefined) {
        expect(result.details?.source).toBe(oracle.details.source);
      }
      if (oracle.details?.issuer !== undefined) {
        expect(result.details?.issuer).toBe(oracle.details.issuer);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

const JSON_HEADERS = { "content-type": "application/json" };

/**
 * Real-world Vercel OpenID Connect metadata captured via
 *   `curl -s https://vercel.com/.well-known/openid-configuration`
 * in April 2026. Kept here (not in the shared fixture) to avoid cross-worktree
 * churn, while still feeding the check a non-synthesised payload end-to-end.
 */
const VERCEL_OIDC_BODY = JSON.stringify({
  issuer: "https://vercel.com",
  jwks_uri: "https://vercel.com/.well-known/jwks",
  authorization_endpoint: "https://vercel.com/oauth/authorize",
  token_endpoint: "https://api.vercel.com/login/oauth/token",
  userinfo_endpoint: "https://api.vercel.com/login/oauth/userinfo",
  grant_types_supported: [
    "authorization_code",
    "client_credentials",
    "refresh_token",
    "urn:ietf:params:oauth:grant-type:device_code",
  ],
});

describe("checkOauthDiscovery — edge cases", () => {
  it("asserts full details parity when fed a real Vercel OIDC payload", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://vercel.com/.well-known/oauth-authorization-server": {
        status: 404,
        headers: {},
      },
      "https://vercel.com/.well-known/openid-configuration": {
        status: 200,
        headers: JSON_HEADERS,
        body: VERCEL_OIDC_BODY,
      },
    });
    const ctx = createScanContext({ url: "https://vercel.com", fetchImpl });
    const result = await checkOauthDiscovery(ctx);

    expect(result.status).toBe("pass");
    expect(result.details?.source).toBe("openid-configuration");
    expect(result.details?.issuer).toBe("https://vercel.com");
    expect(result.details?.hasAuthorizationEndpoint).toBe(true);
    expect(result.details?.hasTokenEndpoint).toBe(true);
    expect(result.details?.hasJwksUri).toBe(true);
    expect(result.details?.grantTypes).toEqual([
      "authorization_code",
      "client_credentials",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:device_code",
    ]);
  });

  it("passes via oauth-authorization-server fallback when only that endpoint responds", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://example.com/.well-known/oauth-authorization-server": {
        status: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({
          issuer: "https://example.com",
          authorization_endpoint: "https://example.com/oauth/authorize",
          token_endpoint: "https://example.com/oauth/token",
          jwks_uri: "https://example.com/.well-known/jwks",
        }),
      },
      "https://example.com/.well-known/openid-configuration": {
        status: 404,
        headers: { "content-type": "text/plain" },
      },
    });
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkOauthDiscovery(ctx);
    expect(result.status).toBe("pass");
    expect(result.details?.source).toBe("oauth-authorization-server");
    expect(result.message).toBe("OAuth authorization server metadata found");
  });

  it("passes when only openid-configuration responds", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://example.com/.well-known/oauth-authorization-server": {
        status: 404,
        headers: { "content-type": "text/plain" },
      },
      "https://example.com/.well-known/openid-configuration": {
        status: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({
          issuer: "https://example.com",
          authorization_endpoint: "https://example.com/oauth/authorize",
          token_endpoint: "https://example.com/oauth/token",
          jwks_uri: "https://example.com/.well-known/jwks",
        }),
      },
    });
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkOauthDiscovery(ctx);
    expect(result.status).toBe("pass");
    expect(result.details?.source).toBe("openid-configuration");
  });

  it("fails when both endpoints return 404", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://example.com/.well-known/oauth-authorization-server": {
        status: 404,
        headers: {},
      },
      "https://example.com/.well-known/openid-configuration": {
        status: 404,
        headers: {},
      },
    });
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkOauthDiscovery(ctx);
    expect(result.status).toBe("fail");
  });

  it("fails when 200 JSON is returned but required fields are missing", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://example.com/.well-known/oauth-authorization-server": {
        status: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({ foo: "bar" }),
      },
      "https://example.com/.well-known/openid-configuration": {
        status: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({ foo: "bar" }),
      },
    });
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkOauthDiscovery(ctx);
    expect(result.status).toBe("fail");
  });

  it("fails when responses are 200 but not JSON", async () => {
    const { fetchImpl } = makeFetchStub({
      "https://example.com/.well-known/oauth-authorization-server": {
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<html></html>",
      },
      "https://example.com/.well-known/openid-configuration": {
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<html></html>",
      },
    });
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkOauthDiscovery(ctx);
    expect(result.status).toBe("fail");
  });

  it("preserves dispatch order (oauth-authorization-server first) regardless of resolution timing", async () => {
    // Delay oauth-authorization-server so openid-configuration resolves first.
    const fetchImpl: typeof fetch = async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (url.endsWith("/oauth-authorization-server")) {
        await new Promise((r) => setTimeout(r, 20));
      }
      return new Response("", { status: 404 });
    };
    const ctx = createScanContext({ url: "https://example.com", fetchImpl });
    const result = await checkOauthDiscovery(ctx);
    expect(result.evidence[0]!.label).toBe(
      "GET /.well-known/oauth-authorization-server",
    );
    expect(result.evidence[1]!.label).toBe(
      "GET /.well-known/openid-configuration",
    );
  });
});
