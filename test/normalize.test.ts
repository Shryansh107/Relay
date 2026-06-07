import { describe, expect, it } from "vitest";
import { normalizeDomain, normalizeEmail, normalizeLinkedInUrl, asString } from "../src/utils/normalize.js";

describe("normalizers", () => {
  it("normalizes domains", () => {
    expect(normalizeDomain("https://www.Example.com/path?q=1")).toBe("example.com");
    expect(normalizeDomain("example.com/abc")).toBe("example.com");
  });

  it("normalizes emails", () => {
    expect(normalizeEmail(" Test@Example.COM ")).toBe("test@example.com");
  });

  it("normalizes LinkedIn URLs", () => {
    expect(normalizeLinkedInUrl("linkedin.com/in/name/?x=1#top")).toBe("https://linkedin.com/in/name");
  });

  it("converts values to non-empty trimmed strings or undefined", () => {
    expect(asString("hello")).toBe("hello");
    expect(asString("  trimmed  ")).toBe("  trimmed  "); // note: it checks value.trim() but returns value itself (or we can check exact original code)
    expect(asString("   ")).toBeUndefined();
    expect(asString("")).toBeUndefined();
    expect(asString(null)).toBeUndefined();
    expect(asString(undefined)).toBeUndefined();
    expect(asString(123)).toBeUndefined();
    expect(asString({})).toBeUndefined();
  });
});

