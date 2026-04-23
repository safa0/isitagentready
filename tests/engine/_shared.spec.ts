/**
 * Unit tests for lib/engine/checks/_shared.ts helpers.
 *
 * Covers the narrow JSON-parsing contract consumed by the Phase-2
 * JSON-probing checks (api-catalog, oauth-discovery, oauth-protected-resource,
 * mcp-server-card). These paths are also exercised transitively by the
 * oracle-driven specs, but that coverage is incidental — the explicit
 * assertions below lock the contract independently of any caller.
 */

import { describe, expect, it } from "vitest";

import { tryParseJson } from "@/lib/engine/checks/_shared";

describe("tryParseJson", () => {
  it("returns undefined when input is undefined", () => {
    expect(tryParseJson(undefined)).toBeUndefined();
  });

  it("returns undefined on empty string (no-body path)", () => {
    expect(tryParseJson("")).toBeUndefined();
  });

  it("parses a simple JSON object", () => {
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns undefined for non-JSON text", () => {
    expect(tryParseJson("not json")).toBeUndefined();
  });

  it("parses JSON arrays", () => {
    expect(tryParseJson("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("parses JSON primitives (null, true, numbers, strings)", () => {
    expect(tryParseJson("null")).toBeNull();
    expect(tryParseJson("true")).toBe(true);
    expect(tryParseJson("42")).toBe(42);
    expect(tryParseJson('"hello"')).toBe("hello");
  });
});
