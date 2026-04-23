/**
 * Security primitives for the public scan surface.
 *
 * - `normaliseScanUrl`: strict URL validator — http(s) only, no embedded
 *   credentials, sensible length caps.
 * - `isPrivateHost`: classifier for private / loopback / link-local /
 *   metadata hosts (IPv4 + IPv6 + magic names).
 * - `assertPublicUrl`: SSRF guard that throws when the hostname is a private
 *   literal or a magic hostname.
 *
 * DNS-based SSRF hardening is out of scope for Phase 3 (we document the
 * limitation and rely on the outbound fetch's network isolation). Literal
 * private IPs and localhost variants ARE blocked without network I/O.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_HOST_LENGTH = 255;

const PRIVATE_HOSTNAME_LITERALS: ReadonlySet<string> = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  // Magic metadata hostnames commonly used for cloud IMDS attacks.
  "metadata.google.internal",
]);

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

export class ScanUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScanUrlError";
  }
}

/**
 * Strict URL normaliser for the public API surface. Accepts only http(s)
 * origins with no embedded credentials and a sensible host length. Returns
 * a fresh `URL` (origin-only; path/query/hash preserved for caller inspection
 * but engine only uses origin).
 */
export function normaliseScanUrl(input: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new ScanUrlError("URL is not a valid absolute URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ScanUrlError(
      `URL must use http or https protocol (got "${parsed.protocol}").`,
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new ScanUrlError("URL must not include credentials.");
  }
  if (parsed.hostname.length === 0 || parsed.hostname.length > MAX_HOST_LENGTH) {
    throw new ScanUrlError(
      `URL host length must be between 1 and ${MAX_HOST_LENGTH} chars.`,
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Private host classification
// ---------------------------------------------------------------------------

function parseIPv4(host: string): readonly number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number.parseInt(part, 10);
    if (n < 0 || n > 255) return null;
    out.push(n);
  }
  return out;
}

function isIPv4Literal(host: string): boolean {
  return parseIPv4(host) !== null;
}

function isPrivateIPv4(octets: readonly number[]): boolean {
  const [a, b] = octets as unknown as [number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local / metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  return false;
}

function stripIPv6Brackets(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}

function isIPv6Literal(host: string): boolean {
  const inner = stripIPv6Brackets(host);
  // A minimum-viable IPv6 detector: contains `:` and only hex digits/colons.
  if (!inner.includes(":")) return false;
  return /^[0-9a-fA-F:]+$/.test(inner);
}

function isPrivateIPv6(host: string): boolean {
  const inner = stripIPv6Brackets(host).toLowerCase();
  if (inner === "::1") return true;
  if (inner === "::") return true;
  // fc00::/7 = ULA (fc00..fdff)
  if (/^fc[0-9a-f]{2}:/.test(inner) || /^fd[0-9a-f]{2}:/.test(inner)) return true;
  // fe80::/10 = link-local (fe80..febf)
  if (/^fe[89ab][0-9a-f]:/.test(inner)) return true;
  return false;
}

/**
 * Returns true iff the hostname is a private/loopback/link-local literal or a
 * magic "local"-style name (localhost / metadata.google.internal / etc.).
 *
 * For non-IP hostnames that aren't on the magic list, returns `false` — DNS
 * resolution is NOT performed here. Full SSRF defence-in-depth requires the
 * network layer (or a pre-connect hook) which is out of scope for Phase 3.
 */
export function isPrivateHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (PRIVATE_HOSTNAME_LITERALS.has(lower)) return true;
  if (lower.endsWith(".localhost")) return true;
  if (isIPv4Literal(lower)) {
    return isPrivateIPv4(parseIPv4(lower)!);
  }
  if (isIPv6Literal(lower)) {
    return isPrivateIPv6(lower);
  }
  return false;
}

/**
 * Throws a `ScanUrlError` when the URL's host looks private. Used by the
 * /api/scan route and the MCP tool handler to short-circuit before any
 * outbound fetch is issued.
 */
export function assertPublicUrl(url: URL): void {
  if (isPrivateHost(url.hostname)) {
    throw new ScanUrlError("URL must resolve to a public host.");
  }
}
