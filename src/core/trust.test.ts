import { describe, expect, it } from "vitest";
import { decideTrust, needsVisibility, parseTrustRules } from "./trust.js";

const pr = { owner: "fullstackhouse", repo: "open-mercato", author: "kamwro" };
const rules = (text: string) => parseTrustRules(text);

describe("parseTrustRules", () => {
  it("ignores blank lines, comments, and trailing comments", () => {
    expect(rules("\n# a comment\nacme/widgets   # one repo\n")).toEqual([
      { negated: false, kind: "repo", pattern: "acme/widgets" },
    ]);
  });

  it("reads a bare owner as every repo under it", () => {
    expect(rules("acme")).toEqual([{ negated: false, kind: "repo", pattern: "acme/*" }]);
  });

  it("distinguishes authors, visibility, and denials", () => {
    expect(rules("@someone\nprivate\n!acme/public")).toEqual([
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
    const both = "fullstackhouse\n!fullstackhouse/open-mercato";
    const reversed = "!fullstackhouse/open-mercato\nfullstackhouse";
    expect(decideTrust(rules(both), pr).trusted).toBe(false);
    expect(decideTrust(rules(reversed), pr).trusted).toBe(false);
    expect(decideTrust(rules(both), { ...pr, repo: "cezar" }).trusted).toBe(true);
  });

  it("is case-insensitive, the way GitHub names are", () => {
    expect(decideTrust(rules("FullStackHouse/Open-Mercato"), pr).trusted).toBe(true);
    expect(decideTrust(rules("@KamWro"), pr).trusted).toBe(true);
  });
});

describe("needsVisibility", () => {
  it("only asks GitHub for visibility when a rule depends on it", () => {
    expect(needsVisibility(rules("acme\n@someone"))).toBe(false);
    expect(needsVisibility(rules("acme\nprivate"))).toBe(true);
  });
});
