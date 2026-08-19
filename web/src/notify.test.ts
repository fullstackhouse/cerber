import { describe, expect, it } from "vitest";
import { announced, arrivals, notice } from "./notify";
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

const pr = (n: number, over: Partial<ReviewListItem> = {}) =>
  row({ key: `acme-web-${n}`, pr: { ...row().pr, number: n }, ...over });

describe("arrivals", () => {
  it("announces a PR the browser has never seen", () => {
    expect(arrivals([pr(1), pr(2)], ["acme-web-1"]).map((r) => r.key)).toEqual(["acme-web-2"]);
  });

  it("says nothing about a queue that has not grown", () => {
    expect(arrivals([pr(1), pr(2)], ["acme-web-1", "acme-web-2"])).toEqual([]);
  });

  it("is not news that a review you already dealt with is still there", () => {
    const list = [
      pr(1, { status: "sent" }),
      pr(2, { status: "reviewed" }),
      pr(3, { status: "skipped" }),
      pr(4, { pr: { ...row().pr, number: 4, state: "MERGED" } }),
      pr(5, { status: "ready" }),
    ];
    expect(arrivals(list, []).map((r) => r.key)).toEqual(["acme-web-5"]);
  });

  it("still announces a PR whose review is already running or failed", () => {
    const list = [pr(1, { status: "running" }), pr(2, { status: "failed" })];
    expect(arrivals(list, []).map((r) => r.key)).toEqual(["acme-web-1", "acme-web-2"]);
  });
});

describe("announced", () => {
  it("remembers reviews that left the queue, so they never arrive twice", () => {
    const list = [pr(1, { status: "sent" }), pr(2, { status: "awaiting" })];
    expect(announced(list)).toEqual(["acme-web-1", "acme-web-2"]);
    expect(arrivals(list, announced(list))).toEqual([]);
  });
});

describe("notice", () => {
  it("stays quiet when nothing arrived", () => {
    expect(notice([])).toBeNull();
  });

  it("names the one PR, and opens it on click", () => {
    const n = notice([pr(7, { pr: { ...row().pr, number: 7, title: "Fix the login redirect" } })])!;
    expect(n.title).toBe("web#7 awaits your review");
    expect(n.body).toBe("Fix the login redirect — mira");
    expect(n.key).toBe("acme-web-7");
  });

  it("folds a batch into one popup that opens the queue", () => {
    const n = notice([pr(1), pr(2), pr(3)])!;
    expect(n.title).toBe("3 PRs await your review");
    expect(n.body).toBe("web#1, web#2, web#3");
    expect(n.key).toBeNull();
  });

  it("counts the tail rather than listing it", () => {
    expect(notice([pr(1), pr(2), pr(3), pr(4), pr(5)])!.body).toBe("web#1, web#2, web#3 and 2 more");
  });

  it("tags the same news identically, so two open tabs show one popup", () => {
    expect(notice([pr(1), pr(2)])!.tag).toBe(notice([pr(2), pr(1)])!.tag);
    expect(notice([pr(1)])!.tag).not.toBe(notice([pr(2)])!.tag);
  });
});
