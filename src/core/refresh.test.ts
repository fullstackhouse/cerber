import { describe, expect, it } from "vitest";
import { Artifact, Comment } from "./artifact.js";
import { mergeRunResult, refreshArtifact } from "./refresh.js";

const DIFF_AT_HEAD1 = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1;
+const b = 2;
 const c = 3;
`;

/** Same code, ten lines further down the file. */
const DIFF_AT_HEAD2 = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -11,3 +11,4 @@
 const a = 1;
+const b = 2;
 const c = 3;
`;

function comment(overrides: Partial<Comment> & Pick<Comment, "id">): Comment {
  return {
    path: "src/a.ts",
    line: 2,
    body: "note",
    chapterId: null,
    severity: null,
    origin: "ai",
    status: "draft",
    editedByUser: false,
    originalLine: null,
    drifted: false,
    ...overrides,
  };
}

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    schemaVersion: 1,
    id: "o/r#1",
    status: "reviewed",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    pr: {
      owner: "o",
      repo: "r",
      number: 1,
      title: "Test PR",
      url: "https://github.com/o/r/pull/1",
      author: "someone",
      body: "",
      baseRefName: "main",
      headRefName: "feat",
      headSha: "head1",
      state: "OPEN",
      isDraft: false,
      additions: 1,
      deletions: 0,
      changedFiles: 1,
    },
    diff: DIFF_AT_HEAD1,
    summary: "Adds b.",
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
    ...overrides,
  };
}

const HEAD2 = { ...makeArtifact().pr, headSha: "head2" };

describe("refreshArtifact", () => {
  it("does nothing when the head has not moved", () => {
    const artifact = makeArtifact({ comments: [comment({ id: "1" })] });
    const result = refreshArtifact(artifact, artifact.pr, DIFF_AT_HEAD2);
    expect(result.changed).toBe(false);
    expect(result.artifact).toBe(artifact);
  });

  it("swaps in the new diff and moves comments onto it", () => {
    const artifact = makeArtifact({ comments: [comment({ id: "1" })] });
    const result = refreshArtifact(artifact, HEAD2, DIFF_AT_HEAD2);

    expect(result.changed).toBe(true);
    expect(result.moved).toBe(1);
    expect(result.artifact.diff).toBe(DIFF_AT_HEAD2);
    expect(result.artifact.pr.headSha).toBe("head2");
    expect(result.artifact.comments[0]!.line).toBe(12);
    expect(result.artifact.refresh).toMatchObject({
      fromSha: "head1",
      toSha: "head2",
      moved: 1,
      drifted: 0,
    });
  });

  it("keeps the human's own words untouched — only the line moves", () => {
    const artifact = makeArtifact({
      comments: [comment({ id: "1", origin: "user", body: "please rename this", status: "approved" })],
    });
    const moved = refreshArtifact(artifact, HEAD2, DIFF_AT_HEAD2).artifact.comments[0]!;
    expect(moved.body).toBe("please rename this");
    expect(moved.status).toBe("approved");
    expect(moved.origin).toBe("user");
  });

  it("keeps a finding's severity through re-anchoring, moved or drifted", () => {
    const artifact = makeArtifact({
      comments: [
        comment({ id: "moves", severity: "blocker" }),
        comment({ id: "drifts", line: 999, severity: "nit" }),
      ],
    });
    const refreshed = refreshArtifact(artifact, HEAD2, DIFF_AT_HEAD2).artifact;
    expect(refreshed.comments.find((c) => c.id === "moves")!.severity).toBe("blocker");
    expect(refreshed.comments.find((c) => c.id === "drifts")!.severity).toBe("nit");
  });
});

describe("mergeRunResult — folding a finished run onto what is on disk", () => {
  // The run owns the draft outright, comments included; what it may not touch
  // are the decisions the user made while it worked.
  const fresh = makeArtifact({
    diff: DIFF_AT_HEAD2,
    summary: "the new draft",
    comments: [comment({ id: "ai-new", body: "fresh ai comment" })],
  });

  it("replaces the previous draft's comments, whoever wrote them", () => {
    const current = makeArtifact({
      comments: [
        comment({ id: "ai-untouched", origin: "ai" }),
        comment({ id: "ai-edited", origin: "ai", editedByUser: true, body: "my rewrite" }),
        comment({ id: "mine", origin: "user", body: "my own note" }),
      ],
    });
    const merged = mergeRunResult(fresh, current);
    expect(merged.comments.map((c) => c.id)).toEqual(["ai-new"]);
    expect(merged.summary).toBe("the new draft");
  });

  it("does not undo a send that landed while the run worked", () => {
    const sent = { at: "2026-08-21T10:02:00.000Z", event: "APPROVE" as const, url: "u", auto: false };
    const merged = mergeRunResult(fresh, makeArtifact({ status: "sent", sent }));
    expect(merged.sent).toEqual(sent);
    expect(merged.status).toBe("sent");
    expect(merged.summary).toBe("the new draft");
  });

  it("does not reopen a decision you made while the run worked", () => {
    for (const status of ["reviewed", "skipped"] as const) {
      expect(mergeRunResult(fresh, makeArtifact({ status })).status).toBe(status);
    }
  });

  it("keeps the conversation, which is the user's writing", () => {
    const chat = [
      { id: "t1", role: "user" as const, at: "2026-08-21T10:01:00.000Z", body: "why?", refs: [], revisions: [], refused: [], costUsd: null },
    ];
    expect(mergeRunResult(fresh, makeArtifact({ chat })).chat).toEqual(chat);
  });

  it("otherwise takes the run's own status", () => {
    expect(mergeRunResult(fresh, makeArtifact({ status: "running" })).status).toBe(fresh.status);
  });
});
