import { describe, expect, it } from "vitest";
import { hasBlockComments, startsInsideComment } from "./highlight";

describe("startsInsideComment", () => {
  it("sees a comment closing before any opens", () => {
    expect(startsInsideComment(" * don't do this\n */\nconst a = 1;")).toBe(true);
    expect(startsInsideComment("  keep this short\n*/\nbody {}")).toBe(true);
  });

  it("sees a closer that ends a line of text", () => {
    expect(startsInsideComment(" * Returns the user's name. */")).toBe(true);
    expect(startsInsideComment(" * see https://x.dev */")).toBe(true);
    expect(startsInsideComment('  (default "a") */')).toBe(true);
  });

  it("reads an opener on a continuation line as the comment's text", () => {
    expect(startsInsideComment(" * matches src/**/*.ts\n */")).toBe(true);
    expect(startsInsideComment(" * one /* two\n * three")).toBe(true);
  });

  it("leaves a comment that opens in the hunk to the highlighter", () => {
    expect(startsInsideComment("/**\n * docs\n */\nconst a = 1;")).toBe(false);
    expect(startsInsideComment("/**\n * docs, no end yet")).toBe(false);
    expect(startsInsideComment("const a = 1; /* note */")).toBe(false);
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

describe("hasBlockComments", () => {
  it("knows which languages have block comments", () => {
    expect(hasBlockComments("typescript")).toBe(true);
    expect(hasBlockComments("css")).toBe(true);
    expect(hasBlockComments("python")).toBe(false);
    expect(hasBlockComments("bash")).toBe(false);
  });
});
