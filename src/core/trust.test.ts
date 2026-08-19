import { describe, expect, it } from "vitest";
import { decideTrust, needsVisibility, parseTrustRule, parseTrustRules } from "./trust.js";

const pr = { owner: "fullstackhouse", repo: "open-mercato", author: "kamwro" };
const rules = (...lines: string[]) => parseTrustRules(lines);

describe("parseTrustRule", () => {
  it("keeps a hand-written trailing comment out of the pattern", () => {
    expect(parseTrustRule("acme/widgets   # the main app")).toEqual({
      negated: false,
      kind: "repo",
      pattern: "acme/widgets",
    });
  });

  it("returns null for nothing worth parsing", () => {
    expect(parseTrustRule("")).toBeNull();
    expect(parseTrustRule("   ")).toBeNull();
    expect(parseTrustRule("# just a note")).toBeNull();
    expect(parseTrustRule("!")).toBeNull();
  });

  it("skips unparseable entries rather than failing the whole list", () => {
    expect(rules("acme", "", "@someone")).toHaveLength(2);
  });

  it("reads a bare owner as every repo under it", () => {
    expect(rules("acme")).toEqual([{ negated: false, kind: "repo", pattern: "acme/*" }]);
  });

  it("distinguishes authors, visibility, and denials", () => {
    expect(rules("@someone", "private", "!acme/public")).toEqual([
      { negated: false, kind: "author", pattern: "someone" },
      { negated: false, kind: "private", pattern: "private" },
      { negated: true, kind: "repo", pattern: "acme/public" },
    ]);
  });
});

describe("decideTrust", () => {
  it("trusts nothing when no rules are written", () => {
    expect(decideTrust([], pr).trusted).toBe(false);
  });

  it("trusts a whole org, and says which rule did it", () => {
    const decision = decideTrust(rules("fullstackhouse"), pr);
    expect(decision.trusted).toBe(true);
    expect(decision.reason).toContain("fullstackhouse/*");
  });

  it("trusts by author regardless of repo", () => {
    expect(decideTrust(rules("@kamwro"), pr).trusted).toBe(true);
    expect(decideTrust(rules("@someone-else"), pr).trusted).toBe(false);
  });

  it("globs within a segment, and keeps a repo rule to its own repo", () => {
    expect(decideTrust(rules("fullstackhouse/open-*"), pr).trusted).toBe(true);
    expect(decideTrust(rules("full*"), pr).trusted).toBe(true); // bare pattern = owner glob
    expect(decideTrust(rules("fullstackhouse/open"), pr).trusted).toBe(false);
    expect(decideTrust(rules("fullstackhouse/cezar"), pr).trusted).toBe(false);
  });

  it("only trusts private repos once visibility is known", () => {
    expect(decideTrust(rules("private"), pr).trusted).toBe(false);
    expect(decideTrust(rules("private"), { ...pr, isPrivate: true }).trusted).toBe(true);
    expect(decideTrust(rules("private"), { ...pr, isPrivate: false }).trusted).toBe(false);
  });

  it("lets a denial beat a grant, whatever the order", () => {
    const both = ["fullstackhouse", "!fullstackhouse/open-mercato"];
    expect(decideTrust(rules(...both), pr).trusted).toBe(false);
    expect(decideTrust(rules(...[...both].reverse()), pr).trusted).toBe(false);
    expect(decideTrust(rules(...both), { ...pr, repo: "cezar" }).trusted).toBe(true);
  });

  it("is case-insensitive, the way GitHub names are", () => {
    expect(decideTrust(rules("FullStackHouse/Open-Mercato"), pr).trusted).toBe(true);
    expect(decideTrust(rules("@KamWro"), pr).trusted).toBe(true);
  });
});

describe("needsVisibility", () => {
  it("only asks GitHub for visibility when a rule depends on it", () => {
    expect(needsVisibility(rules("acme", "@someone"))).toBe(false);
    expect(needsVisibility(rules("acme", "private"))).toBe(true);
  });
});
