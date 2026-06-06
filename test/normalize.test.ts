import { describe, expect, it } from "vitest";
import { normalizeDomain, normalizeEmail, normalizeLinkedInUrl } from "../src/utils/normalize.js";

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
});
