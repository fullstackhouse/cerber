import { describe, expect, it } from "vitest";
import {
  ageLabel,
  hiddenAwaiting,
  hiddenAwaitingNote,
  isArchived,
  replyOf,
  replyTag,
  sortReviews,
  stillAwaitingLabel,
  strip,
  tabOf,
  verdictCell,
  walkable,
} from "./inbox";
import { DaemonStatus, ReviewListItem } from "./types";

const row = (over: Partial<ReviewListItem> = {}): ReviewListItem => ({
  id: "acme/web#1",
  key: "acme-web-1",
  status: "ready",
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
  verdict: { recommendation: "approve", confidence: 91, reasoning: "Reads fine." },
  commentCount: 2,
  costUsd: 0.31,
  withSource: true,
  ...over,
});

/** Awaiting entries for ids we don't care about the reply state of. */
const at = (...ids: string[]) => ids.map((id) => ({ id, reply: "none" as const }));

const daemon = (over: Partial<Extract<DaemonStatus, { enabled: true }>> = {}): DaemonStatus => ({
  enabled: true,
  polling: false,
  repos: ["acme/web"],
  intervalMs: 300_000,
  pollEnabled: true,
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
  autoSendCandidates: 1,
  ...over,
});

describe("tabOf", () => {
  it("puts everything with no draft yet under awaiting", () => {
    expect(tabOf(row({ status: "awaiting" }))).toBe("awaiting");
    expect(tabOf(row({ status: "running" }))).toBe("awaiting");
  });

  it("puts a draft the user has acted on under drafted, not sent", () => {
    for (const status of ["ready", "reviewed", "skipped", "failed"]) {
      expect(tabOf(row({ status }))).toBe("drafted");
    }
  });

  it("puts only what reached GitHub under sent", () => {
    expect(tabOf(row({ status: "sent" }))).toBe("sent");
  });
});

describe("walkable", () => {
  it("walks open PRs that still want you, and only those", () => {
    const list = [
      row({ key: "sent", status: "sent" }),
      row({ key: "merged", pr: { ...row().pr, state: "MERGED" } }),
      row({ key: "reviewed", status: "reviewed" }),
      row({ key: "skipped", status: "skipped" }),
      row({ key: "ready", status: "ready" }),
      row({ key: "awaiting", status: "awaiting" }),
    ];
    expect(walkable(list).map((r) => r.key)).toEqual(["ready", "awaiting"]);
  });

  it("drops a review the moment you settle it, so the walk moves forward", () => {
    const list = [row({ key: "a", status: "ready" }), row({ key: "b", status: "ready" })];
    expect(walkable(list).map((r) => r.key)).toEqual(["a", "b"]);
    const settled = [{ ...list[0]!, status: "reviewed" }, list[1]!];
    expect(walkable(settled).map((r) => r.key)).toEqual(["b"]);
  });
});

describe("hiddenAwaiting", () => {
  // The reported case: the strip counted two, the queue showed none.
  const settledPair = [
    row({ id: "fsh/groomershop-mercato#375", key: "a", status: "reviewed" }),
    row({ id: "fsh/open-mercato#98", key: "b", status: "skipped" }),
  ];

  it("finds the awaiting PRs the queue filed away", () => {
    const hidden = hiddenAwaiting(
      settledPair,
      daemon({ awaiting: at("fsh/groomershop-mercato#375", "fsh/open-mercato#98") }),
    );
    expect(hidden.map((r) => r.key)).toEqual(["a", "b"]);
    // …and the queue itself is genuinely empty, which is what made them vanish.
    expect(walkable(settledPair)).toEqual([]);
  });

  it("stays quiet about the ones the queue is already showing", () => {
    const list = [row({ id: "acme/web#1", key: "shown", status: "ready" })];
    expect(hiddenAwaiting(list, daemon({ awaiting: at("acme/web#1") }))).toEqual([]);
  });

  it("surfaces one GitHub still wants even while others fill the queue", () => {
    const list = [...settledPair, row({ id: "acme/web#9", key: "live", status: "ready" })];
    const hidden = hiddenAwaiting(list, daemon({ awaiting: at("fsh/open-mercato#98", "acme/web#9") }));
    expect(hidden.map((r) => r.key)).toEqual(["b"]);
  });

  it("surfaces an awaiting PR cerber has archived on stale state", () => {
    const closed = row({ id: "acme/web#4", key: "c", pr: { ...row().pr, state: "CLOSED" } });
    expect(hiddenAwaiting([closed], daemon({ awaiting: at("acme/web#4") })).map((r) => r.key)).toEqual(["c"]);
  });

  it("claims nothing when there is no poll to claim it", () => {
    expect(hiddenAwaiting(settledPair, daemon({ awaiting: [] }))).toEqual([]);
    expect(hiddenAwaiting(settledPair, null)).toEqual([]);
    expect(hiddenAwaiting(settledPair, { enabled: false })).toEqual([]);
  });
});

describe("hiddenAwaitingNote", () => {
  it("reports the open request, rather than telling you what you owe", () => {
    expect(hiddenAwaitingNote([row({ status: "reviewed" }), row({ status: "skipped" })])).toBe(
      "Nothing new in the inbox — but GitHub still has 2 review requests open on you. " +
        "You settled them here without submitting a review, so they sit in the drawers below, tagged with whose move it is.",
    );
  });

  it("reads as one request when there is one", () => {
    expect(hiddenAwaitingNote([row({ status: "skipped" })])).toBe(
      "Nothing new in the inbox — but GitHub still has 1 review request open on you. " +
        "You settled it here without submitting a review, so it sits in the drawers below, tagged with whose move it is.",
    );
  });

  it("never contradicts the decision the row already shows", () => {
    // "still awaiting you" beside a `skipped` badge read as two opposite claims
    // about the same row. The note states GitHub's side and leaves the decision be.
    const note = hiddenAwaitingNote([row({ status: "skipped" })]);
    expect(note).not.toMatch(/awaits? you|still asks you for/);
    expect(note).toContain("without submitting a review");
  });

  it("does not call an archived row settled — nobody settled it", () => {
    const closed = row({ pr: { ...row().pr, state: "CLOSED" } });
    expect(hiddenAwaitingNote([closed])).toContain("settled or archived it here");
  });
});

describe("replyOf / replyTag", () => {
  const r = row({ id: "acme/web#1" });

  it("carries whose move it is off the last poll", () => {
    expect(replyOf(r, daemon({ awaiting: [{ id: "acme/web#1", reply: "them" }] }))).toBe("them");
  });

  it("claims nothing about a row the poll never mentioned", () => {
    expect(replyOf(r, daemon({ awaiting: at("acme/web#9") }))).toBe("unknown");
    expect(replyOf(r, daemon())).toBe("unknown");
    expect(replyOf(r, null)).toBe("unknown");
  });

  it("says who is waiting, not what you owe", () => {
    // The complaint that started this: a tag reading as a demand beside a
    // `skipped` badge. Every label states a fact about the conversation.
    expect(replyTag("none").label).toBe("you haven't replied");
    expect(replyTag("you").label).toBe("waiting on them");
    expect(replyTag("them").label).toBe("they replied last");
  });

  it("falls back to the bare fact when the conversation could not be read", () => {
    // Never guess "you haven't replied" at someone who has — that is the very
    // mislabel this feature exists to prevent.
    expect(replyTag("unknown").label).toBe("unanswered on GitHub");
    expect(replyTag("unknown").title).toContain("could not read the conversation");
  });
});

describe("stillAwaitingLabel", () => {
  const a = row({ id: "acme/web#1", key: "a", status: "reviewed" });
  const b = row({ id: "acme/web#2", key: "b", status: "skipped" });

  it("counts the open requests in this drawer, without claiming whose move it is", () => {
    // The rows say whose move it is. A label asserting they are all on you
    // would contradict a row that reads "waiting on them".
    expect(stillAwaitingLabel([a, b], [a])).toBe(" · 1 open review request");
    expect(stillAwaitingLabel([a, b], [a, b])).toBe(" · 2 open review requests");
  });

  it("leaves a drawer of finished work reading as it always did", () => {
    expect(stillAwaitingLabel([a, b], [])).toBe("");
  });
});

describe("sortReviews", () => {
  it("puts what wants you most on top, newest first inside a band", () => {
    const list = [
      row({ key: "sent", status: "sent" }),
      row({ key: "running", status: "running" }),
      row({ key: "failed", status: "failed" }),
      row({ key: "ready-old", status: "ready", updatedAt: "2026-08-01T12:00:00.000Z" }),
      row({ key: "awaiting", status: "awaiting" }),
      row({ key: "ready-new", status: "ready", updatedAt: "2026-08-19T12:00:00.000Z" }),
    ];
    expect(sortReviews(list).map((r) => r.key)).toEqual([
      "ready-new",
      "ready-old",
      "awaiting",
      "running",
      "failed",
      "sent",
    ]);
  });
});

describe("isArchived", () => {
  it("archives merged and closed PRs, keeps open ones", () => {
    expect(isArchived(row())).toBe(false);
    expect(isArchived(row({ pr: { ...row().pr, state: "MERGED" } }))).toBe(true);
    expect(isArchived(row({ pr: { ...row().pr, state: "CLOSED" } }))).toBe(true);
  });
});

describe("ageLabel", () => {
  const now = Date.parse("2026-08-19T12:00:00.000Z");
  it("reads as a glance, not a timestamp", () => {
    expect(ageLabel("2026-08-19T11:59:50.000Z", now)).toBe("now");
    expect(ageLabel("2026-08-19T11:48:00.000Z", now)).toBe("12m");
    expect(ageLabel("2026-08-19T10:00:00.000Z", now)).toBe("2h");
    expect(ageLabel("2026-08-14T12:00:00.000Z", now)).toBe("5d");
  });
});

describe("verdictCell", () => {
  it("says what the row is waiting for before it says a verdict", () => {
    expect(verdictCell(row({ status: "awaiting" }))).toEqual({ label: "review now", tone: "awaiting" });
    expect(verdictCell(row({ status: "running" }))).toEqual({ label: "reviewing…", tone: "running" });
    expect(verdictCell(row({ status: "failed" }))).toEqual({ label: "run failed", tone: "failed" });
  });

  it("shows the verdict with its confidence", () => {
    expect(verdictCell(row())).toEqual({ label: "approve 91", tone: "approve" });
    expect(
      verdictCell(row({ verdict: { recommendation: "request_changes", confidence: 82, reasoning: "" } })),
    ).toEqual({ label: "request changes 82", tone: "changes" });
  });

  it("shows what a sent review actually posted", () => {
    const sent = row({
      status: "sent",
      sent: { at: "2026-08-14T09:00:00.000Z", event: "APPROVE", url: null, auto: true },
    });
    expect(verdictCell(sent)).toEqual({ label: "sent · approve", tone: "sent" });
  });
});

describe("strip", () => {
  it("explains a drafted row with the verdict's own reasoning", () => {
    const s = strip(row(), daemon());
    expect(s.reasoning).toBe("Reads fine.");
    expect(s.meta).toContain("read the full source");
    expect(s.meta).toContain("≈$0.31 at API rates");
    expect(s.meta).toContain("2 comments drafted");
  });

  it("names off-diff comments, which post in the body rather than inline", () => {
    const s = strip(row({ commentCount: 6, driftedCount: 1 }), daemon());
    expect(s.meta).toContain("6 comments drafted, 1 off-diff");
  });

  it("says where an approve sits against the auto-send bar", () => {
    expect(strip(row({ verdict: { recommendation: "approve", confidence: 91, reasoning: "" } }), daemon()).meta).toContain(
      "auto-send candidate at 91%",
    );
    expect(strip(row({ verdict: { recommendation: "approve", confidence: 74, reasoning: "" } }), daemon()).meta).toContain(
      "below the 85% auto-send bar",
    );
  });

  it("stays quiet about the bar for verdicts auto-send never touches", () => {
    const s = strip(row({ verdict: { recommendation: "comment", confidence: 74, reasoning: "" } }), daemon());
    expect(s.meta.some((m) => m.includes("auto-send"))).toBe(false);
  });

  it("says what you already did with a row you settled", () => {
    expect(strip(row({ status: "reviewed" }), daemon()).meta[0]).toBe("you marked this reviewed");
    expect(strip(row({ status: "skipped" }), daemon()).meta[0]).toBe("you skipped this");
    expect(strip(row(), daemon()).meta.some((m) => m.startsWith("you "))).toBe(false);
  });

  it("surfaces the failure on a run that died", () => {
    const s = strip(row({ status: "failed", runError: "gh: not authenticated" }), daemon());
    expect(s.reasoning).toBe("gh: not authenticated");
  });

  it("reports a sent review as a record, not a draft", () => {
    const s = strip(
      row({ status: "sent", sent: { at: "2026-08-14T09:00:00.000Z", event: "APPROVE", url: null, auto: true } }),
      daemon(),
    );
    expect(s.reasoning).toContain("Sent to GitHub as approve");
    expect(s.meta).toContain("auto-sent by the daemon");
  });
});
