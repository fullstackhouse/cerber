import { describe, expect, it } from "vitest";
import { startsInsideComment } from "./highlight";

describe("startsInsideComment", () => {
  it("sees a comment closing before any opens", () => {
    expect(startsInsideComment(" * don't do this\n */\nconst a = 1;")).toBe(true);
    expect(startsInsideComment("  keep this short\n*/\nbody {}")).toBe(true);
  });

  it("leaves a comment that opens in the hunk to the highlighter", () => {
    expect(startsInsideComment("/**\n * docs\n */\nconst a = 1;")).toBe(false);
    expect(startsInsideComment("/**\n * docs, no end yet")).toBe(false);
  });

  it("sees a hunk made only of continuation lines", () => {
    expect(startsInsideComment(" * one\n *\n\n * two")).toBe(true);
  });

  it("ignores a glob or a regex that happens to spell */", () => {
    expect(startsInsideComment('const g = ["**/*.ts"];')).toBe(false);
    expect(startsInsideComment('s.replace(/\\s*/g, "");')).toBe(false);
  });

  it("leaves plain code alone", () => {
    expect(startsInsideComment("const a = 1;\nconst b = a\n  * 2;")).toBe(false);
    expect(startsInsideComment("")).toBe(false);
  });
});
