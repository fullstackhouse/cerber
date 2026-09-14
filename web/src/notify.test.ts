import { describe, expect, it } from "vitest";
import { announced, arrivals, daemonAnnouncesHere, daemonDrafts, notice } from "./notify";
import { DaemonStatus, ReviewListItem } from "./types";

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

// Nobody is drafting for you, so a PR landing is all the news there will be.
const BY_HAND = false;
/** The default: cerber drafts every arrival itself, and that takes minutes. */
const DRAFTING = true;

describe("arrivals", () => {
  it("announces a PR the browser has never seen", () => {
    expect(arrivals([pr(1), pr(2)], ["acme-web-1"], BY_HAND).map((r) => r.key)).toEqual([
      "acme-web-2",
    ]);
  });

  it("says nothing about a queue that has not grown", () => {
    expect(arrivals([pr(1), pr(2)], ["acme-web-1", "acme-web-2"], BY_HAND)).toEqual([]);
  });

  it("is not news that a review you already dealt with is still there", () => {
    const list = [
      pr(1, { status: "sent" }),
      pr(2, { status: "reviewed" }),
      pr(3, { status: "skipped" }),
      pr(4, { pr: { ...row().pr, number: 4, state: "MERGED" } }),
      pr(5, { status: "ready" }),
    ];
    expect(arrivals(list, [], BY_HAND).map((r) => r.key)).toEqual(["acme-web-5"]);
  });

  it("announces a PR whose review failed — nothing more is coming for it", () => {
    expect(arrivals([pr(1, { status: "failed" })], [], DRAFTING).map((r) => r.key)).toEqual([
      "acme-web-1",
    ]);
  });

  // The bug this rule exists for: a tap that lands on "no run yet, press r",
  // and then silence at the moment there is finally something to read.
  it("holds back a PR cerber is about to draft, and announces the draft instead", () => {
    const landed = [pr(1, { status: "awaiting" }), pr(2, { status: "running" })];
    expect(arrivals(landed, [], DRAFTING)).toEqual([]);

    const seen = announced(landed, DRAFTING);
    const readies = [pr(1, { status: "ready" }), pr(2, { status: "ready" })];
    expect(arrivals(readies, seen, DRAFTING).map((r) => r.key)).toEqual(["acme-web-1", "acme-web-2"]);
  });

  it("announces the arrival itself when nobody is going to draft it", () => {
    expect(arrivals([pr(1, { status: "awaiting" })], [], BY_HAND).map((r) => r.key)).toEqual([
      "acme-web-1",
    ]);
  });
});

describe("announced", () => {
  it("remembers reviews that left the queue, so they never arrive twice", () => {
    const list = [pr(1, { status: "sent" }), pr(2, { status: "awaiting" })];
    expect(arrivals(list, announced(list, BY_HAND), BY_HAND)).toEqual([]);
  });

  // Recording one would spend its announcement on the silence.
  it("does not remember a row it is still holding back", () => {
    const list = [pr(1, { status: "awaiting" }), pr(2, { status: "sent" })];
    expect(announced(list, DRAFTING)).not.toContain("acme-web-1");
    expect(announced(list, DRAFTING)).toContain("acme-web-2");
  });

  // The daemon's ledger records *what* it said, because "nobody is drafting
  // this" and "here is the draft" are different news. The seen-set says it
  // with a key of its own, or the two channels tell different stories.
  it("announces the draft to a browser it already told the run had failed", () => {
    const failed = [pr(1, { status: "failed" })];
    const seenOnce = announced(failed, DRAFTING, []);
    expect(arrivals(failed, seenOnce, DRAFTING)).toEqual([]);

    const running = [pr(1, { status: "running" })];
    const kept = announced(running, DRAFTING, seenOnce);
    const readyAgain = [pr(1, { status: "ready" })];
    expect(arrivals(readyAgain, kept, DRAFTING).map((r) => r.key)).toEqual(["acme-web-1"]);
  });

  // The other direction is not news: a PR you were told about is not worth a
  // second popup for a re-review that broke, or for one that drafted again.
  it("stays quiet about a row whose draft it has already announced", () => {
    const ready = [pr(1, { status: "ready" })];
    const seenOnce = announced(ready, DRAFTING, []);
    expect(arrivals(ready, seenOnce, DRAFTING)).toEqual([]);

    const kept = announced([pr(1, { status: "running" })], DRAFTING, seenOnce);
    expect(arrivals(ready, kept, DRAFTING)).toEqual([]);
    expect(arrivals([pr(1, { status: "failed" })], kept, DRAFTING)).toEqual([]);
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

  it("leads with what the finished draft found", () => {
    const ready = pr(7, {
      status: "ready",
      pr: { ...row().pr, number: 7, title: "Fix the login redirect" },
      verdict: { recommendation: "request_changes", confidence: 80, reasoning: "" },
      blockerCount: 2,
    });
    const n = notice([ready])!;
    expect(n.title).toBe("web#7 draft ready");
    expect(n.body).toBe("requests changes · 2 blockers — Fix the login redirect");
    expect(n.key).toBe("acme-web-7");
  });

  it("says approves, with no blocker count to give", () => {
    const ready = pr(7, {
      status: "ready",
      verdict: { recommendation: "approve", confidence: 90, reasoning: "" },
      blockerCount: 0,
    });
    expect(notice([ready])!.body).toBe("approves — a change");
  });

  it("calls a batch of drafts what it is", () => {
    const ready = (n: number) => pr(n, { status: "ready" });
    expect(notice([ready(1), ready(2)])!.title).toBe("2 drafts ready");
    // One of them is only an arrival, so the headline true of both is used.
    expect(notice([ready(1), pr(2, { status: "failed" })])!.title).toBe("2 PRs await your review");
  });

  it("tags the same news identically, so two open tabs show one popup", () => {
    expect(notice([pr(1), pr(2)])!.tag).toBe(notice([pr(2), pr(1)])!.tag);
    expect(notice([pr(1)])!.tag).not.toBe(notice([pr(2)])!.tag);
  });
});

describe("who announces an arrival when both could", () => {
  const daemon = (over: Partial<Extract<DaemonStatus, { enabled: true }>> = {}): DaemonStatus => ({
    enabled: true,
    polling: false,
    repos: [],
    intervalMs: 300_000,
    pollEnabled: true,
    notify: true,
    autoReview: true,
    trustedRuns: false,
    polls: 3,
    errors: 0,
    lastPollAt: null,
    nextPollAt: null,
    lastSummary: null,
    awaiting: [],
    lastPollError: null,
    autoSend: "shadow",
    autoSendThreshold: 85,
    autoSent: 0,
    autoSendCandidates: 0,
    ...over,
  });

  it("stands down when serve is tapping this same machine", () => {
    expect(daemonAnnouncesHere(daemon(), "127.0.0.1")).toBe(true);
    expect(daemonAnnouncesHere(daemon(), "localhost")).toBe(true);
  });

  // The notification would land on the VPS, where nobody is looking — this
  // browser is that setup's only channel.
  it("keeps ringing for a cockpit served from somewhere else", () => {
    expect(daemonAnnouncesHere(daemon(), "cerber.example.com")).toBe(false);
    expect(daemonAnnouncesHere(daemon(), "192.168.1.20")).toBe(false);
  });

  it("keeps ringing when the machine's own notification is off", () => {
    expect(daemonAnnouncesHere(daemon({ notify: false }), "127.0.0.1")).toBe(false);
  });

  it("keeps ringing when there is no daemon to defer to", () => {
    expect(daemonAnnouncesHere(null, "127.0.0.1")).toBe(false);
    expect(daemonAnnouncesHere({ enabled: false }, "127.0.0.1")).toBe(false);
  });

  describe("whether anything is coming for an undrafted row", () => {
    it("reads it off the daemon when the status says", () => {
      expect(daemonDrafts(daemon(), false)).toBe(true);
      expect(daemonDrafts(daemon({ autoReview: false }), true)).toBe(false);
      expect(daemonDrafts(daemon({ pollEnabled: false }), true)).toBe(false);
      expect(daemonDrafts({ enabled: false }, true)).toBe(false);
    });

    // A read that failed answers nothing. Taken for a no, it announces a row
    // the daemon is drafting right now — and the draft-ready tap then arrives
    // second, two popups for one PR out of a single hiccup.
    it("keeps the last answer when the status read fails", () => {
      expect(daemonDrafts(null, true)).toBe(true);
      expect(daemonDrafts(null, false)).toBe(false);
    });
  });
});
