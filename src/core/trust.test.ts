import { describe, expect, it } from "vitest";
import {
  TrustContext,
  decideTrust,
  membershipQueries,
  needsVisibility,
  parseTrustRule,
  parseTrustRules,
} from "./trust.js";

const rules = (...lines: string[]) => parseTrustRules(lines);

/** A teammate's PR: branch pushed to the repo itself, so they can write here. */
const insider: TrustContext = {
  owner: "fullstackhouse",
  repo: "open-mercato",
  author: "kamwro",
  pushAccess: true,
  memberships: new Set(["fullstackhouse/*", "fullstackhouse/devs"]),
};

/** A drive-by PR from a fork against the same public repo. */
const outsider: TrustContext = {
  owner: "fullstackhouse",
  repo: "open-mercato",
  author: "stranger",
  pushAccess: false,
  memberships: new Set(),
};

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
    expect(parseTrustRule("@")).toBeNull();
  });

  it("reads a bare owner as every repo under it", () => {
    expect(rules("acme")).toEqual([{ negated: false, kind: "repo", pattern: "acme/*" }]);
  });

  it("tells a person, a team, and a whole org apart", () => {
    expect(rules("@someone", "@acme/devs", "@acme/*")).toEqual([
      { negated: false, kind: "author", pattern: "someone" },
      { negated: false, kind: "membership", pattern: "acme/devs" },
      { negated: false, kind: "membership", pattern: "acme/*" },
    ]);
  });

  it("distinguishes visibility and denials", () => {
    expect(rules("private", "!acme/public")).toEqual([
      { negated: false, kind: "private", pattern: "private" },
      { negated: true, kind: "repo", pattern: "acme/public" },
    ]);
  });
});

describe("decideTrust — a repo is not a set of people", () => {
  it("does not trust a fork PR just because the repo is trusted", () => {
    // The whole point: anyone may open a PR against a public repo.
    expect(decideTrust(rules("fullstackhouse"), outsider).trusted).toBe(false);
    expect(decideTrust(rules("fullstackhouse/open-mercato"), outsider).trusted).toBe(false);
  });

  it("trusts a repo rule when the branch was pushed to the repo itself", () => {
    expect(decideTrust(rules("fullstackhouse"), insider).trusted).toBe(true);
  });

  it("holds a private repo to the same bar", () => {
    const priv = { ...outsider, isPrivate: true };
    expect(decideTrust(rules("private"), priv).trusted).toBe(false);
    expect(decideTrust(rules("private"), { ...priv, pushAccess: true }).trusted).toBe(true);
  });

  it("still trusts a teammate's fork PR, because the rule is about them", () => {
    const teammateOnAFork = { ...insider, pushAccess: false };
    expect(decideTrust(rules("@fullstackhouse/devs"), teammateOnAFork).trusted).toBe(true);
    expect(decideTrust(rules("@kamwro"), teammateOnAFork).trusted).toBe(true);
  });
});

describe("decideTrust — membership", () => {
  it("trusts a team, and says which rule did it", () => {
    const decision = decideTrust(rules("@fullstackhouse/devs"), insider);
    expect(decision.trusted).toBe(true);
    expect(decision.reason).toContain("@fullstackhouse/devs");
  });

  it("does not trust a team the author is not on", () => {
    expect(decideTrust(rules("@fullstackhouse/frontend"), insider).trusted).toBe(false);
  });

  it("treats an unresolved membership as not a member", () => {
    // memberships is what GitHub confirmed; a failed lookup leaves it out.
    const unresolved = { ...insider, memberships: undefined };
    expect(decideTrust(rules("@fullstackhouse/devs"), unresolved).trusted).toBe(false);
  });

  it("trusts every member of an org without trusting the org's repos", () => {
    expect(decideTrust(rules("@fullstackhouse/*"), insider).trusted).toBe(true);
    expect(decideTrust(rules("@fullstackhouse/*"), outsider).trusted).toBe(false);
  });
});

describe("decideTrust — general", () => {
  it("trusts nothing when no rules are written", () => {
    expect(decideTrust([], insider).trusted).toBe(false);
  });

  it("globs within a segment, and keeps a repo rule to its own repo", () => {
    expect(decideTrust(rules("fullstackhouse/open-*"), insider).trusted).toBe(true);
    expect(decideTrust(rules("fullstackhouse/open"), insider).trusted).toBe(false);
    expect(decideTrust(rules("fullstackhouse/cezar"), insider).trusted).toBe(false);
  });

  it("lets a denial beat a grant, whatever the order", () => {
    const both = ["@fullstackhouse/*", "!fullstackhouse/open-mercato"];
    expect(decideTrust(rules(...both), insider).trusted).toBe(false);
    expect(decideTrust(rules(...[...both].reverse()), insider).trusted).toBe(false);
    expect(decideTrust(rules(...both), { ...insider, repo: "cezar" }).trusted).toBe(true);
  });

  it("denies a repo even for a fork PR, where a grant would not have applied", () => {
    // A denial that needed push access would miss exactly the PRs it targets.
    expect(decideTrust(rules("@fullstackhouse/*", "!fullstackhouse/open-mercato"), {
      ...insider,
      pushAccess: false,
    }).trusted).toBe(false);
  });

  it("is case-insensitive, the way GitHub names are", () => {
    expect(decideTrust(rules("FullStackHouse/Open-Mercato"), insider).trusted).toBe(true);
    expect(decideTrust(rules("@KamWro"), insider).trusted).toBe(true);
    expect(decideTrust(rules("@FullStackHouse/Devs"), insider).trusted).toBe(true);
  });
});

describe("lookups a rule set demands", () => {
  it("only asks GitHub for visibility when a rule depends on it", () => {
    expect(needsVisibility(rules("acme", "@someone"))).toBe(false);
    expect(needsVisibility(rules("acme", "private"))).toBe(true);
  });

  it("asks for each org and team once, denials included", () => {
    expect(membershipQueries(rules("@acme/devs", "@acme/*", "@acme/devs", "!@other/sre"))).toEqual([
      { org: "acme", team: "devs", key: "acme/devs" },
      { org: "acme", team: null, key: "acme/*" },
      { org: "other", team: "sre", key: "other/sre" },
    ]);
  });

  it("asks for nothing when no rule is about people", () => {
    expect(membershipQueries(rules("acme", "private", "@someone"))).toEqual([]);
  });
});
