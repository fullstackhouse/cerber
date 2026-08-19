import { describe, expect, it } from "vitest";
import {
  TrustRuleError,
  decideTrust,
  membershipQueries,
  parseTrustRule,
  parseTrustRules,
} from "./trust.js";

const rules = (...lines: string[]) => parseTrustRules(lines);

const teammate = {
  author: "kamwro",
  memberships: new Set(["fullstackhouse/*", "fullstackhouse/devs"]),
};
const stranger = { author: "stranger", memberships: new Set<string>() };

describe("parseTrustRule — only people are trustable", () => {
  it("refuses a repo, and says what to write instead", () => {
    expect(() => parseTrustRule("fullstackhouse/open-mercato")).toThrow(TrustRuleError);
    expect(() => parseTrustRule("fullstackhouse/open-mercato")).toThrow(
      /Trust is about people, not repositories/,
    );
    expect(() => parseTrustRule("fullstackhouse")).toThrow(/@fullstackhouse\/\*/);
  });

  it("refuses the old private-repo shorthand on its own terms", () => {
    expect(() => parseTrustRule("private")).toThrow(/visibility says nothing about who opened/);
    // Not the generic repo message, which would suggest a nonsense "@private/*".
    expect(() => parseTrustRule("private")).not.toThrow(/@private/);
  });

  it("refuses a handle that names nobody", () => {
    expect(() => parseTrustRule("@")).toThrow(/names nobody/);
    expect(() => parseTrustRule("@acme/team/extra")).toThrow(/not a login, team, or org/);
  });

  it("returns null for a line holding nothing", () => {
    expect(parseTrustRule("")).toBeNull();
    expect(parseTrustRule("   ")).toBeNull();
    expect(parseTrustRule("# just a note")).toBeNull();
  });

  it("tells a person, a team, and a whole org apart", () => {
    expect(rules("@someone", "@acme/devs", "@acme/*")).toEqual([
      { negated: false, kind: "author", pattern: "someone" },
      { negated: false, kind: "membership", pattern: "acme/devs" },
      { negated: false, kind: "membership", pattern: "acme/*" },
    ]);
  });

  it("keeps a hand-written trailing comment out of the pattern", () => {
    expect(parseTrustRule("@acme/devs   # the platform team")).toEqual({
      negated: false,
      kind: "membership",
      pattern: "acme/devs",
    });
  });

  it("reads a leading ! as a denial", () => {
    expect(parseTrustRule("!@acme/*")).toEqual({
      negated: true,
      kind: "membership",
      pattern: "acme/*",
    });
  });
});

describe("decideTrust", () => {
  it("trusts nobody when no rules are written", () => {
    expect(decideTrust([], teammate).trusted).toBe(false);
  });

  it("trusts a team, and records which rule did it", () => {
    const decision = decideTrust(rules("@fullstackhouse/devs"), teammate);
    expect(decision.trusted).toBe(true);
    expect(decision.reason).toBe("trusted by @fullstackhouse/devs");
  });

  it("does not trust a team the author is not on", () => {
    expect(decideTrust(rules("@fullstackhouse/frontend"), teammate).trusted).toBe(false);
  });

  it("trusts anyone in the org, and nobody outside it", () => {
    expect(decideTrust(rules("@fullstackhouse/*"), teammate).trusted).toBe(true);
    expect(decideTrust(rules("@fullstackhouse/*"), stranger).trusted).toBe(false);
  });

  it("trusts one person by login", () => {
    expect(decideTrust(rules("@kamwro"), teammate).trusted).toBe(true);
    expect(decideTrust(rules("@kamwro"), stranger).trusted).toBe(false);
  });

  it("treats an unresolved membership as not a member", () => {
    // memberships holds what GitHub confirmed; a failed lookup leaves it out.
    expect(decideTrust(rules("@fullstackhouse/devs"), { author: "kamwro" }).trusted).toBe(false);
  });

  it("lets a denial beat a grant, whatever the order", () => {
    const both = ["@fullstackhouse/*", "!@kamwro"];
    expect(decideTrust(rules(...both), teammate).trusted).toBe(false);
    expect(decideTrust(rules(...[...both].reverse()), teammate).trusted).toBe(false);
    expect(decideTrust(rules(...both), { ...teammate, author: "someone-else" }).trusted).toBe(true);
  });

  it("is case-insensitive, the way GitHub names are", () => {
    expect(decideTrust(rules("@KamWro"), teammate).trusted).toBe(true);
    expect(decideTrust(rules("@FullStackHouse/Devs"), teammate).trusted).toBe(true);
  });

  it("globs a login, but never across the org separator", () => {
    expect(decideTrust(rules("@kam*"), teammate).trusted).toBe(true);
    expect(decideTrust(rules("@*"), teammate).trusted).toBe(true);
    expect(decideTrust(rules("@*"), { author: "anyone" }).trusted).toBe(true);
  });
});

describe("membershipQueries", () => {
  it("asks for each org and team once, denials included", () => {
    expect(membershipQueries(rules("@acme/devs", "@acme/*", "@acme/devs", "!@other/sre"))).toEqual([
      { org: "acme", team: "devs", key: "acme/devs" },
      { org: "acme", team: null, key: "acme/*" },
      { org: "other", team: "sre", key: "other/sre" },
    ]);
  });

  it("asks GitHub nothing when every rule names a login", () => {
    expect(membershipQueries(rules("@someone", "!@someone-else"))).toEqual([]);
  });
});
