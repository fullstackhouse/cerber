import { describe, expect, it } from "vitest";
import { anyAutoReview, autoReviewFor } from "./autoreview.js";

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
