import { describe, expect, it } from "vitest";
import { anyAutoReview, autoReviewFor, capAutoReview, setException } from "./autoreview.js";

describe("autoReviewFor", () => {
  it("follows the default for a repo with no exception", () => {
    expect(autoReviewFor({ autoReview: true, autoReviewRepos: {} }, "acme", "web")).toBe(true);
    expect(autoReviewFor({ autoReview: false, autoReviewRepos: {} }, "acme", "web")).toBe(false);
  });

  it("lets an exception win in either direction", () => {
    const knobs = { autoReview: true, autoReviewRepos: { "acme/infra": false } };
    expect(autoReviewFor(knobs, "acme", "infra")).toBe(false);
    expect(autoReviewFor(knobs, "acme", "web")).toBe(true);
    const off = { autoReview: false, autoReviewRepos: { "acme/web": true } };
    expect(autoReviewFor(off, "acme", "web")).toBe(true);
    expect(autoReviewFor(off, "acme", "infra")).toBe(false);
  });

  it("matches owner/repo the way GitHub does, ignoring case", () => {
    const knobs = { autoReview: true, autoReviewRepos: { "Acme/Infra": false } };
    expect(autoReviewFor(knobs, "acme", "infra")).toBe(false);
  });
});

describe("anyAutoReview", () => {
  it("is true while the default or any exception drafts", () => {
    expect(anyAutoReview({ autoReview: true, autoReviewRepos: {} })).toBe(true);
    expect(anyAutoReview({ autoReview: false, autoReviewRepos: { "a/b": false } })).toBe(false);
    expect(anyAutoReview({ autoReview: false, autoReviewRepos: { "a/b": true } })).toBe(true);
  });
});

describe("capAutoReview", () => {
  // --no-auto-review means this process starts no runs, the trust warning's
  // advice included — an exception set to true does not get past it.
  it("drafts nothing under the flag, exceptions included", () => {
    const knobs = { autoReview: false, autoReviewRepos: { "acme/web": true } };
    expect(anyAutoReview(capAutoReview(knobs, false))).toBe(false);
    expect(autoReviewFor(capAutoReview(knobs, false), "acme", "web")).toBe(false);
  });

  it("leaves the config alone without the flag", () => {
    const knobs = { autoReview: false, autoReviewRepos: { "acme/web": true } };
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
