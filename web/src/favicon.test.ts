import { describe, expect, it } from "vitest";
import { faviconHref, hasInboxWork } from "./favicon";
import { ReviewListItem } from "./types";

const row = (over: Partial<ReviewListItem> = {}): ReviewListItem => ({
  id: "acme/web#1",
  key: "acme-web-1",
  status: "awaiting",
  updatedAt: "2026-08-19T12:00:00.000Z",
  pr: {
    title: "a change",
    url: "https://github.com/acme/web/pull/1",
    author: "mira",
    owner: "acme",
    repo: "web",
    number: 1,
    state: "OPEN",
    additions: 10,
    deletions: 2,
    changedFiles: 3,
  },
  verdict: null,
  commentCount: 0,
  costUsd: null,
  ...over,
});

describe("hasInboxWork", () => {
  it("is false on an empty queue", () => {
    expect(hasInboxWork([])).toBe(false);
  });

  it("is true for a PR nobody has drafted yet", () => {
    expect(hasInboxWork([row({ status: "awaiting" })])).toBe(true);
  });

  it("is true for a draft waiting to be read", () => {
    expect(hasInboxWork([row({ status: "ready" })])).toBe(true);
  });

  it("is false once every row is settled, sent or archived", () => {
    expect(
      hasInboxWork([
        row({ key: "a", status: "reviewed" }),
        row({ key: "b", status: "skipped" }),
        row({ key: "c", status: "sent" }),
        row({ key: "d", status: "ready", pr: { ...row().pr, state: "MERGED" } }),
      ]),
    ).toBe(false);
  });

  it("still wants the dot when one live row sits among filed ones", () => {
    expect(hasInboxWork([row({ key: "a", status: "sent" }), row({ key: "b", status: "ready" })])).toBe(
      true,
    );
  });
});

describe("faviconHref", () => {
  it("badges the icon only while there is work", () => {
    expect(faviconHref(true)).toBe("/favicon-dot.svg");
    expect(faviconHref(false)).toBe("/favicon.svg");
  });
});
