import { describe, expect, it } from "vitest";
import { Artifact, Comment, SCHEMA_VERSION } from "./artifact.js";
import { MAX_ENTRIES, appendHistory, describeChange, withWriter } from "./history.js";

function artifact(over: Partial<Artifact> = {}): Artifact {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: "acme/widgets#42",
    status: "ready",
    createdAt: "2026-08-19T00:00:00Z",
    updatedAt: "2026-08-19T00:00:00Z",
    pr: {
      owner: "acme",
      repo: "widgets",
      number: 42,
      title: "Add a thing",
      url: "u",
      author: "someone",
      body: "",
      baseRefName: "main",
      headRefName: "f",
      headSha: "306658c1111",
      state: "OPEN",
      isDraft: false,
      additions: 1,
      deletions: 0,
      changedFiles: 1,
    },
    diff: "diff",
    summary: "s",
    chapters: [],
    comments: [],
    verdict: null,
    run: null,
    sent: null,
    refresh: null,
    filed: null,
    calibration: null,
    chat: [],
    preChat: null,
    pendingChat: null,
    ...over,
  };
}

function comment(over: Partial<Comment> = {}): Comment {
  return {
    id: "c1",
    path: "src/a.ts",
    line: 3,
    body: "this is wrong",
    chapterId: null,
    severity: "blocker",
    origin: "ai",
    status: "draft",
    editedByUser: false,
    originalLine: null,
    drifted: false,
    ...over,
  };
}

const run = (over: Partial<NonNullable<Artifact["run"]>> = {}) => ({
  model: "haiku",
  startedAt: "2026-08-24T11:10:00Z",
  finishedAt: null,
  costUsd: null,
  error: null,
  withSource: true,
  trusted: false,
  sessionId: null,
  trigger: "daemon" as const,
  reviewedSha: null,
  ...over,
});

describe("describeChange", () => {
  it("says a row appeared in the inbox", () => {
    expect(describeChange(null, artifact({ status: "awaiting" }))).toEqual([
      "appeared in the inbox — GitHub is asking you for a review",
    ]);
  });

  it("records the status change that a single updatedAt would erase", () => {
    const before = artifact({ status: "ready" });
    expect(describeChange(before, artifact({ status: "skipped" }))).toEqual([
      "status ready → skipped",
    ]);
  });

  it("records a push under the review", () => {
    const before = artifact();
    const after = artifact({ pr: { ...before.pr, headSha: "5502944aaaa" } });
    expect(describeChange(before, after)).toEqual(["head moved 306658c → 5502944"]);
  });

  it("says what a run could read and who asked for it", () => {
    expect(describeChange(artifact(), artifact({ status: "running", run: run() }))).toEqual([
      "status ready → running",
      "review started (haiku, reading the source, asked for by the poll)",
    ]);
    expect(
      describeChange(
        artifact(),
        artifact({ status: "running", run: run({ withSource: false, trusted: true, trigger: "user" }) }),
      )[1],
    ).toBe("review started (haiku, diff only, trusted — may run commands, asked for by you)");
  });

  it("records what a finished run cost and which commit it read", () => {
    const started = artifact({ status: "running", run: run() });
    const finished = artifact({
      status: "ready",
      run: run({ finishedAt: "2026-08-24T11:17:28Z", costUsd: 6.8, reviewedSha: "306658c1111" }),
      verdict: { recommendation: "request_changes", confidence: 72, reasoning: "r" },
      comments: [comment(), comment({ id: "c2", origin: "user" })],
    });
    expect(describeChange(started, finished)).toEqual([
      "status running → ready",
      "review finished at 306658c (≈$6.80 at API rates)",
      "verdict set to request changes (72% sure of the findings)",
      "comments: +1 from the review, +1 you wrote",
    ]);
  });

  it("records a failure rather than a finish", () => {
    const started = artifact({ status: "running", run: run() });
    const failed = artifact({
      status: "failed",
      run: run({ finishedAt: "2026-08-24T11:17:28Z", error: "claude exited 1" }),
    });
    expect(describeChange(started, failed)).toEqual([
      "status running → failed",
      "review failed: claude exited 1",
    ]);
  });

  it("counts what happened to the comments", () => {
    const before = artifact({
      comments: [comment(), comment({ id: "c2" }), comment({ id: "c3" })],
    });
    const after = artifact({
      comments: [
        comment({ body: "reworded" }),
        comment({ id: "c2", status: "dropped" }),
        comment({ id: "c4", origin: "user", severity: null }),
      ],
    });
    expect(describeChange(before, after)).toEqual([
      "comments: +1 you wrote, 1 edited, 1 dropped, 1 gone",
    ]);
  });

  it("records a send, a filing and a pull-forward", () => {
    const before = artifact();
    expect(
      describeChange(
        before,
        artifact({
          status: "sent",
          sent: { at: "2026-08-25T09:00:00Z", event: "APPROVE", url: null, auto: true },
        }),
      ),
    ).toEqual(["status ready → sent", "sent to GitHub as approve, by auto-send"]);

    expect(
      describeChange(
        before,
        artifact({
          filed: { at: "2026-08-25T09:00:00Z", reason: "request-withdrawn", review: null, reply: null },
        }),
      ),
    ).toEqual(["filed under settled — nobody is asking for this review any more"]);

    expect(
      describeChange(
        before,
        artifact({
          refresh: {
            at: "2026-08-25T08:26:00Z",
            fromSha: "306658c",
            toSha: "5502944",
            moved: 1,
            drifted: 1,
          },
        }),
      ),
    ).toEqual(["pulled forward onto 5502944 — 1 comment(s) followed the code, 1 drifted"]);
  });

  it("ignores a running turn's narration — it says nothing about where the review got to", () => {
    const before = artifact({
      pendingChat: { message: "why?", refs: [], startedAt: "t", progress: ["reading a.ts"], error: null },
    });
    const after = artifact({
      pendingChat: {
        message: "why?",
        refs: [],
        startedAt: "t",
        progress: ["reading a.ts", "searching for foo", "thinking"],
        error: null,
      },
    });
    expect(describeChange(before, after)).toEqual([]);
  });
});

describe("appendHistory", () => {
  it("keeps what is on disk and ignores the copy the caller is holding", () => {
    const prior = artifact({
      history: [{ at: "2026-08-24T11:07:00Z", by: "daemon", what: "appeared", cause: "poll" }],
    });
    // The stale artifact a re-review built minutes ago: its own history is empty.
    const stale = artifact({ status: "sent", history: [] });
    const history = appendHistory(prior, stale);
    expect(history.map((e) => e.what)).toEqual(["appeared", "status ready → sent"]);
  });

  it("stamps each entry with whoever is writing", () => {
    const entries = withWriter({ by: "cockpit", cause: "PATCH /api/reviews/x" }, () =>
      appendHistory(artifact(), artifact({ status: "skipped" })),
    );
    expect(entries).toEqual([
      expect.objectContaining({ by: "cockpit", cause: "PATCH /api/reviews/x", what: "status ready → skipped" }),
    ]);
  });

  it("attributes nothing when nothing claimed the write", () => {
    expect(appendHistory(artifact(), artifact({ status: "skipped" }))[0]).toMatchObject({
      by: "unknown",
      cause: null,
    });
  });

  it("records a decision that changed nothing, once", () => {
    const note = "left alone: you marked it skipped";
    const first = appendHistory(artifact(), artifact(), { note });
    expect(first.map((e) => e.what)).toEqual([note]);
    // The poll re-takes this decision every few minutes; saying so every time
    // would bury everything else.
    const again = appendHistory(artifact({ history: first }), artifact(), { note });
    expect(again).toEqual(first);
  });

  it("says so rather than claiming the review began, when the old file cannot be read", () => {
    expect(appendHistory(null, artifact(), { unreadable: true }).map((e) => e.what)).toEqual([
      "history restarts here — the previous file could not be read",
    ]);
  });

  it("caps a pathological row and admits what it dropped", () => {
    const history = Array.from({ length: MAX_ENTRIES + 40 }, (_, i) => ({
      at: "2026-08-24T11:07:00Z",
      by: "daemon" as const,
      what: `entry ${i}`,
      cause: null,
    }));
    const capped = appendHistory(artifact({ history }), artifact({ status: "skipped" }));
    expect(capped).toHaveLength(MAX_ENTRIES);
    expect(capped[0]?.what).toBe("… earlier entries dropped");
    expect(capped.at(-1)?.what).toBe("status ready → skipped");
  });
});
