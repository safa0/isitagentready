import { describe, it, expect } from "vitest";
import { ScanRequestSchema, ScanResponseSchema, CheckIdSchema } from "@/lib/schema";

describe("schema", () => {
  it("accepts a minimal scan request", () => {
    const parsed = ScanRequestSchema.parse({ url: "https://example.com" });
    expect(parsed.url).toBe("https://example.com");
  });

  it("enumerates all 19 check IDs", () => {
    expect(CheckIdSchema.options).toHaveLength(19);
  });

  it("rejects malformed scan response", () => {
    const result = ScanResponseSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
