import { describe, expect, it } from "vitest";
import { parseStickyChapters } from "./sticky-chapters";

describe("parseStickyChapters", () => {
  it("is on unless switched off", () => {
    expect(parseStickyChapters(null)).toBe(true);
    expect(parseStickyChapters("")).toBe(true);
    expect(parseStickyChapters("on")).toBe(true);
    expect(parseStickyChapters("off")).toBe(false);
  });
});
