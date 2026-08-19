import { describe, expect, it } from "vitest";
import { parsePrRef } from "./gh.js";

describe("parsePrRef", () => {
  it("parses a full PR URL", () => {
    expect(parsePrRef("https://github.com/fullstackhouse/skills/pull/22")).toEqual({
      owner: "fullstackhouse",
      repo: "skills",
      number: 22,
    });
  });

  it("parses owner/repo#number", () => {
    expect(parsePrRef("open-mercato/cezar#7")).toEqual({
      owner: "open-mercato",
      repo: "cezar",
      number: 7,
    });
  });

  it("parses a bare number with --repo", () => {
    expect(parsePrRef("123", "a/b")).toEqual({ owner: "a", repo: "b", number: 123 });
    expect(parsePrRef("#123", "a/b")).toEqual({ owner: "a", repo: "b", number: 123 });
  });

  it("rejects a bare number without --repo", () => {
    expect(() => parsePrRef("123")).toThrow(/--repo/);
  });

  it("rejects garbage", () => {
    expect(() => parsePrRef("what is this")).toThrow(/Cannot parse/);
  });
});
