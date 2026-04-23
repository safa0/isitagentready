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
  // A minimum-viable IPv6 detector: contains `:` and only hex digits, colons,
  // or dots (dots appear in IPv4-mapped IPv6 addresses, e.g. `::ffff:1.2.3.4`).
  if (!inner.includes(":")) return false;
  return /^[0-9a-fA-F:.]+$/.test(inner);
}

function isPrivateIPv6(host: string): boolean {
  const inner = stripIPv6Brackets(host).toLowerCase();
  if (inner === "::1") return true;
  if (inner === "::") return true;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:XXXX:YYYY). Conservative:
  // treat every v4-mapped address as needs-check and refuse regardless of
  // the embedded IPv4's class. This is the correct stance for an SSRF guard
  // — a public v4 wrapped in v6 is rare in client input and the risk of a
  // misclassified loopback (e.g. [::ffff:7f00:1]) dwarfs the false-positive
  // cost.
  if (/^::ffff:/i.test(inner)) return true;
  // IPv4-compatible IPv6 (deprecated, ::a.b.c.d) — likewise refuse. Restrict
  // to the dotted-quad form so legitimate IPv6 addresses like `::2` aren't
  // misclassified as private. `::` and `::1` are already handled above.
  if (/^::(\d{1,3}\.){3}\d{1,3}$/.test(inner)) return true;
  // fc00::/7 = ULA (fc00..fdff)
  if (/^fc[0-9a-f]{2}:/.test(inner) || /^fd[0-9a-f]{2}:/.test(inner)) return true;
  // fe80::/10 = link-local (fe80..febf)
  if (/^fe[89ab][0-9a-f]:/.test(inner)) return true;
  // fec0::/10 = site-local (deprecated; still-reserved to defeat legacy hosts)
  if (/^fec[0-9a-f]:/.test(inner) || /^fed[0-9a-f]:/.test(inner)) return true;
  if (/^fee[0-9a-f]:/.test(inner) || /^fef[0-9a-f]:/.test(inner)) return true;
  // 2002::/16 = 6to4 — can wrap a private IPv4, treat as private since we
  // can't easily decode the embedded address without a full IPv6 parser.
  if (/^2002:/.test(inner)) return true;
  // 64:ff9b::/96 = NAT64 well-known prefix. Addresses under this prefix
  // embed an IPv4 — most operators use it for internal translation, so
  // refuse in the same spirit as the v4-mapped and 6to4 blocks above.
  if (/^64:ff9b:/.test(inner)) return true;
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
    const octets = parseIPv4(lower);
    if (octets === null) return false;
    return isPrivateIPv4(octets);
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
