import { describe, expect, it } from "vitest";
import { AutoReviewKnobs, anyAutoReview, autoReviewFor, capAutoReview, setException } from "./autoreview.js";

const knobsOf = (over: Partial<AutoReviewKnobs>): AutoReviewKnobs => ({
  autoReview: true,
  autoReviewRepos: {},
  autoReviewTeamRequests: true,
  ...over,
});
const asked = (owner: string, repo: string) => ({ owner, repo, requestedViaTeam: false });
const teamAsked = (owner: string, repo: string) => ({ owner, repo, requestedViaTeam: true });

describe("autoReviewFor", () => {
  it("follows the default for a repo with no exception", () => {
    expect(autoReviewFor(knobsOf({ autoReview: true }), asked("acme", "web"))).toBe(true);
    expect(autoReviewFor(knobsOf({ autoReview: false }), asked("acme", "web"))).toBe(false);
  });

  it("lets an exception win in either direction", () => {
    const knobs = knobsOf({ autoReviewRepos: { "acme/infra": false } });
    expect(autoReviewFor(knobs, asked("acme", "infra"))).toBe(false);
    expect(autoReviewFor(knobs, asked("acme", "web"))).toBe(true);
    const off = knobsOf({ autoReview: false, autoReviewRepos: { "acme/web": true } });
    expect(autoReviewFor(off, asked("acme", "web"))).toBe(true);
    expect(autoReviewFor(off, asked("acme", "infra"))).toBe(false);
  });

  it("matches owner/repo the way GitHub does, ignoring case", () => {
    const knobs = knobsOf({ autoReviewRepos: { "Acme/Infra": false } });
    expect(autoReviewFor(knobs, asked("acme", "infra"))).toBe(false);
  });

  it("drafts a team's request like any other by default", () => {
    expect(autoReviewFor(knobsOf({}), teamAsked("acme", "web"))).toBe(true);
  });

  // The switch is about who was asked, not where: a repo drafted by its own
  // exception still leaves a team's request to the click.
  it("leaves a team's request to the click with the switch off, whatever the repo says", () => {
    const knobs = knobsOf({ autoReview: false, autoReviewRepos: { "acme/web": true }, autoReviewTeamRequests: false });
    expect(autoReviewFor(knobs, teamAsked("acme", "web"))).toBe(false);
    expect(autoReviewFor(knobs, asked("acme", "web"))).toBe(true);
  });

  // Not knowing who was asked is no reason to draft what the switch keeps back.
  it("treats a request nobody could classify like a team's", () => {
    const unknown = { owner: "acme", repo: "web", requestedViaTeam: null };
    expect(autoReviewFor(knobsOf({ autoReviewTeamRequests: false }), unknown)).toBe(false);
    expect(autoReviewFor(knobsOf({}), unknown)).toBe(true);
  });
});

describe("anyAutoReview", () => {
  it("is true while the default or any exception drafts", () => {
    expect(anyAutoReview(knobsOf({ autoReview: true }))).toBe(true);
    expect(anyAutoReview(knobsOf({ autoReview: false, autoReviewRepos: { "a/b": false } }))).toBe(false);
    expect(anyAutoReview(knobsOf({ autoReview: false, autoReviewRepos: { "a/b": true } }))).toBe(true);
  });
});

describe("capAutoReview", () => {
  // --no-auto-review means this process starts no runs, the trust warning's
  // advice included — an exception set to true does not get past it.
  it("drafts nothing under the flag, exceptions and team requests included", () => {
    const knobs = knobsOf({ autoReview: false, autoReviewRepos: { "acme/web": true } });
    expect(anyAutoReview(capAutoReview(knobs, false))).toBe(false);
    expect(autoReviewFor(capAutoReview(knobs, false), asked("acme", "web"))).toBe(false);
    expect(autoReviewFor(capAutoReview(knobs, false), teamAsked("acme", "web"))).toBe(false);
  });

  it("leaves the config alone without the flag", () => {
    const knobs = knobsOf({ autoReview: false, autoReviewRepos: { "acme/web": true } });
    expect(capAutoReview(knobs, true)).toBe(knobs);
  });
});

describe("setException", () => {
  it("adds one repo and leaves the rest", () => {
    expect(setException({ "acme/web": true }, "acme/infra", false)).toEqual({ "acme/web": true, "acme/infra": false });
  });

  it("replaces another spelling of the same repo rather than adding beside it", () => {
    expect(setException({ "Acme/Web": true, "acme/api": false }, "acme/web", false)).toEqual({
      "acme/api": false,
      "acme/web": false,
    });
  });

  it("removes with null, whatever the spelling", () => {
    expect(setException({ "Acme/Web": true, "acme/api": false }, "acme/web", null)).toEqual({ "acme/api": false });
  });
});
