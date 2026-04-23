/**
 * Discovery check: `oauthDiscovery`.
 *
 * Specification (FINDINGS §3 / §9)
 * --------------------------------
 * Probe both well-known OAuth/OIDC metadata endpoints concurrently:
 *   - `/.well-known/oauth-authorization-server` (RFC 8414)
 *   - `/.well-known/openid-configuration`       (OIDC Discovery 1.0)
 *
 * Pass criterion: either endpoint returns 200 JSON with `issuer` and
 * `authorization_endpoint` fields. We additionally record `token_endpoint`
 * and `jwks_uri` presence in `details` to match the oracle shape.
 *
 * Evidence timeline
 * -----------------
 * For each endpoint: `fetch` step; if 200 JSON, a `validate` step also.
 * Terminal step is always a single `conclude`. Concurrent probes mean
 * ordering is non-deterministic — we emit the two probes' steps in the order
 * their fetch promises resolve, then append the conclusion.
 */

import type { CheckResult, EvidenceStep } from "@/lib/schema";
import {
  fetchToStep,
  makeStep,
  type FetchOutcome,
  type ScanContext,
} from "@/lib/engine/context";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

interface EndpointSpec {
  readonly slug: "oauth-authorization-server" | "openid-configuration";
  readonly path: string;
  readonly fetchLabel: string;
  readonly validateLabel: string;
  readonly sourceName: string;
}

const ENDPOINTS: readonly EndpointSpec[] = [
  {
    slug: "oauth-authorization-server",
    path: "/.well-known/oauth-authorization-server",
    fetchLabel: "GET /.well-known/oauth-authorization-server",
    validateLabel: "Validate oauth-authorization-server structure",
    sourceName: "oauth-authorization-server",
  },
  {
    slug: "openid-configuration",
    path: "/.well-known/openid-configuration",
    fetchLabel: "GET /.well-known/openid-configuration",
    validateLabel: "Validate openid-configuration structure",
    sourceName: "openid-configuration",
  },
];

const CONCLUDE_LABEL = "Conclusion";
const PASS_MESSAGE_OIDC = "OpenID Connect discovery metadata found";
const PASS_MESSAGE_OAUTH = "OAuth authorization server metadata found";
const FAIL_MESSAGE = "No OAuth/OIDC discovery metadata found";
const FAIL_CONCLUDE_SUMMARY =
  "No OAuth/OIDC discovery metadata found at either well-known path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tryParseJson(body: string | undefined): unknown | undefined {
  if (body === undefined || body.length === 0) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

interface ValidatedMetadata {
  readonly issuer: string;
  readonly hasAuthorizationEndpoint: boolean;
  readonly hasTokenEndpoint: boolean;
  readonly hasJwksUri: boolean;
  readonly grantTypes?: readonly string[];
}

function validateMetadata(json: unknown): ValidatedMetadata | undefined {
  if (json === null || typeof json !== "object") return undefined;
  const obj = json as Record<string, unknown>;
  const issuer = typeof obj.issuer === "string" ? obj.issuer : undefined;
  const authz =
    typeof obj.authorization_endpoint === "string"
      ? obj.authorization_endpoint
      : undefined;
  if (issuer === undefined || authz === undefined) return undefined;
  const grantTypes = Array.isArray(obj.grant_types_supported)
    ? (obj.grant_types_supported.filter((v) => typeof v === "string") as string[])
    : undefined;
  return {
    issuer,
    hasAuthorizationEndpoint: true,
    hasTokenEndpoint: typeof obj.token_endpoint === "string",
    hasJwksUri: typeof obj.jwks_uri === "string",
    ...(grantTypes !== undefined ? { grantTypes } : {}),
  };
}

interface ProbeResult {
  readonly endpoint: EndpointSpec;
  readonly outcome: FetchOutcome;
  readonly metadata?: ValidatedMetadata;
  readonly fetchFinding: { outcome: "positive" | "negative"; summary: string };
  readonly validateFinding?: {
    outcome: "positive" | "negative";
    summary: string;
  };
}

async function probe(
  ctx: ScanContext,
  endpoint: EndpointSpec,
): Promise<ProbeResult> {
  const outcome = await ctx.fetch(endpoint.path);

  if (outcome.response === undefined) {
    return {
      endpoint,
      outcome,
      fetchFinding: {
        outcome: "negative",
        summary: `${endpoint.slug} request failed: ${outcome.error ?? "no response"}`,
      },
    };
  }

  if (outcome.response.status !== 200) {
    return {
      endpoint,
      outcome,
      fetchFinding: {
        outcome: "negative",
        summary: `${endpoint.slug} returned ${outcome.response.status}`,
      },
    };
  }

  const json = tryParseJson(outcome.body);
  if (json === undefined) {
    return {
      endpoint,
      outcome,
      fetchFinding: {
        outcome: "negative",
        summary: `${endpoint.slug} returned 200 but body was not valid JSON`,
      },
    };
  }

  const metadata = validateMetadata(json);
  if (metadata === undefined) {
    return {
      endpoint,
      outcome,
      fetchFinding: {
        outcome: "negative",
        summary: `${endpoint.slug} JSON missing required issuer/authorization_endpoint`,
      },
      validateFinding: {
        outcome: "negative",
        summary: "Missing required issuer/authorization_endpoint",
      },
    };
  }

  return {
    endpoint,
    outcome,
    metadata,
    fetchFinding: {
      outcome: "positive",
      summary: `Received JSON from ${endpoint.slug}`,
    },
    validateFinding: {
      outcome: "positive",
      summary: `Valid metadata with issuer: ${metadata.issuer}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function checkOauthDiscovery(
  ctx: ScanContext,
): Promise<CheckResult> {
  const started = Date.now();

  // Probe both endpoints concurrently; emit evidence in resolution order.
  const probes: Promise<ProbeResult>[] = ENDPOINTS.map((e) => probe(ctx, e));
  const results: ProbeResult[] = [];
  // We emit in resolution order using Promise.allSettled then sorting by start
  // index would lose the concurrent ordering behaviour. Instead race each to
  // completion in any order via a small helper:
  await Promise.all(
    probes.map(async (p) => {
      const r = await p;
      results.push(r);
    }),
  );

  const evidence: EvidenceStep[] = [];
  for (const r of results) {
    evidence.push(
      fetchToStep(r.outcome, r.endpoint.fetchLabel, r.fetchFinding),
    );
    if (r.validateFinding !== undefined) {
      evidence.push(
        makeStep("validate", r.endpoint.validateLabel, r.validateFinding),
      );
    }
  }

  // Prefer the OIDC result when both pass (matches vercel oracle message).
  const passing = results.find((r) => r.metadata !== undefined);
  const oidcPass = results.find(
    (r) => r.metadata !== undefined && r.endpoint.slug === "openid-configuration",
  );
  const chosen = oidcPass ?? passing;

  if (chosen !== undefined && chosen.metadata !== undefined) {
    const message =
      chosen.endpoint.slug === "openid-configuration"
        ? PASS_MESSAGE_OIDC
        : PASS_MESSAGE_OAUTH;
    evidence.push(
      makeStep("conclude", CONCLUDE_LABEL, {
        outcome: "positive",
        summary: message,
      }),
    );
    return {
      status: "pass",
      message,
      details: {
        source: chosen.endpoint.sourceName,
        issuer: chosen.metadata.issuer,
        hasAuthorizationEndpoint: chosen.metadata.hasAuthorizationEndpoint,
        hasTokenEndpoint: chosen.metadata.hasTokenEndpoint,
        hasJwksUri: chosen.metadata.hasJwksUri,
        ...(chosen.metadata.grantTypes !== undefined
          ? { grantTypes: chosen.metadata.grantTypes }
          : {}),
      },
      evidence,
      durationMs: Date.now() - started,
    };
  }

  evidence.push(
    makeStep("conclude", CONCLUDE_LABEL, {
      outcome: "negative",
      summary: FAIL_CONCLUDE_SUMMARY,
    }),
  );

  return {
    status: "fail",
    message: FAIL_MESSAGE,
    evidence,
    durationMs: Date.now() - started,
  };
}
