/**
 * Failing specs for `lib/engine/security.ts` — SSRF guard + URL validation.
 */

import { describe, expect, it } from "vitest";

import {
  assertPublicUrl,
  isPrivateHost,
  normaliseScanUrl,
} from "@/lib/engine/security";

describe("normaliseScanUrl", () => {
  it("accepts http and https", () => {
    expect(normaliseScanUrl("https://example.com").origin).toBe(
      "https://example.com",
    );
    expect(normaliseScanUrl("http://example.com").origin).toBe(
      "http://example.com",
    );
  });

  it("rejects non-http(s) protocols", () => {
    expect(() => normaliseScanUrl("ftp://example.com")).toThrow(/protocol/i);
    expect(() => normaliseScanUrl("file:///etc/passwd")).toThrow(/protocol/i);
    expect(() => normaliseScanUrl("javascript:alert(1)")).toThrow(/protocol/i);
  });

  it("rejects embedded credentials", () => {
    expect(() => normaliseScanUrl("https://user:pass@example.com")).toThrow(
      /credential/i,
    );
  });

  it("rejects overly long hosts", () => {
    const host = "a".repeat(256) + ".com";
    expect(() => normaliseScanUrl(`https://${host}`)).toThrow(/host/i);
  });

  it("rejects malformed URLs", () => {
    expect(() => normaliseScanUrl("not-a-url")).toThrow();
  });
});

describe("isPrivateHost", () => {
  it("detects IPv4 loopback, RFC1918, link-local", () => {
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("10.0.0.1")).toBe(true);
    expect(isPrivateHost("10.255.255.255")).toBe(true);
    expect(isPrivateHost("172.16.0.1")).toBe(true);
    expect(isPrivateHost("172.31.255.254")).toBe(true);
    expect(isPrivateHost("172.32.0.1")).toBe(false);
    expect(isPrivateHost("192.168.1.1")).toBe(true);
    expect(isPrivateHost("169.254.169.254")).toBe(true); // cloud metadata
    expect(isPrivateHost("0.0.0.0")).toBe(true);
  });

  it("detects IPv6 loopback + ULA + link-local", () => {
    expect(isPrivateHost("::1")).toBe(true);
    expect(isPrivateHost("fc00::1")).toBe(true);
    expect(isPrivateHost("fd12:3456:789a::1")).toBe(true);
    expect(isPrivateHost("fe80::1")).toBe(true);
  });

  it("classifies public hosts as public", () => {
    expect(isPrivateHost("8.8.8.8")).toBe(false);
    expect(isPrivateHost("example.com")).toBe(false);
    expect(isPrivateHost("2606:4700::1")).toBe(false);
  });

  it("treats `localhost` and variants as private", () => {
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("LOCALHOST")).toBe(true);
  });

  it("treats IPv4-mapped IPv6 loopback/private addresses as private (H6)", () => {
    // Dotted-quad form.
    expect(isPrivateHost("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateHost("::ffff:10.0.0.1")).toBe(true);
    // Hex-pair form (::ffff:7f00:1 == 127.0.0.1).
    expect(isPrivateHost("::ffff:7f00:1")).toBe(true);
  });

  it("treats CGNAT 100.64.0.0/10 as private", () => {
    expect(isPrivateHost("100.64.0.1")).toBe(true);
    expect(isPrivateHost("100.127.255.254")).toBe(true);
    expect(isPrivateHost("100.63.255.255")).toBe(false);
    expect(isPrivateHost("100.128.0.1")).toBe(false);
  });

  it("treats the IPv6 all-zero address as private", () => {
    expect(isPrivateHost("::")).toBe(true);
  });

  it("treats foo.localhost and ip6-* variants as private", () => {
    expect(isPrivateHost("foo.localhost")).toBe(true);
    expect(isPrivateHost("bar.baz.localhost")).toBe(true);
    expect(isPrivateHost("ip6-localhost")).toBe(true);
    expect(isPrivateHost("ip6-loopback")).toBe(true);
  });

  it("treats metadata.google.internal as private", () => {
    expect(isPrivateHost("metadata.google.internal")).toBe(true);
  });
});

describe("assertPublicUrl", () => {
  it("passes for public hosts", () => {
    // Use a resolvable public host; the function is a string-first check that
    // delegates to DNS only when the hostname isn't an IP literal.
    expect(() => assertPublicUrl(new URL("https://example.com"))).not.toThrow();
  });

  it("rejects private IP literals without DNS lookup", async () => {
    expect(() => assertPublicUrl(new URL("http://127.0.0.1"))).toThrow(
      /public host/i,
    );
    expect(() => assertPublicUrl(new URL("http://10.0.0.1"))).toThrow(
      /public host/i,
    );
    expect(() => assertPublicUrl(new URL("http://[::1]"))).toThrow(
      /public host/i,
    );
  });

  it("rejects localhost by name", () => {
    expect(() => assertPublicUrl(new URL("http://localhost"))).toThrow(
      /public host/i,
    );
  });
});
