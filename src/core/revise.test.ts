import { describe, expect, it } from "vitest";
import { Artifact, Comment, SCHEMA_VERSION } from "./artifact.js";
import { applyRevisions, mergeConcurrentEdits, restoreReview, snapshotReview } from "./revise.js";

function comment(over: Partial<Comment> = {}): Comment {
  return {
    id: "c1",
    path: "src/a.ts",
    line: 10,
    body: "AI wrote this.",
    chapterId: "one",
    origin: "ai",
    status: "draft",
    editedByUser: false,
    originalLine: null,
    drifted: false,
    ...over,
  };
}

function artifact(over: Partial<Artifact> = {}): Artifact {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: "o/r#1",
    status: "ready",
    createdAt: "2026-08-19T00:00:00Z",
    updatedAt: "2026-08-19T00:00:00Z",
    pr: {
      owner: "o",
      repo: "r",
      number: 1,
      title: "t",
      url: "u",
      author: "a",
      body: "",
      baseRefName: "main",
      headRefName: "f",
      headSha: "abc",
      state: "OPEN",
      additions: 1,
      deletions: 0,
      changedFiles: 1,
    },
    diff: "",
    summary: "The original summary.",
    chapters: [{ id: "one", title: "One", explanation: "Explains one.", files: ["src/a.ts"] }],
    comments: [comment()],
    verdict: { recommendation: "comment", confidence: 70, reasoning: "because" },
    run: null,
    sent: null,
    refresh: null,
    calibration: null,
    chat: [],
    preChat: null,
    ...over,
  };
}

const ids = () => {
  let n = 0;
  return () => `new-${++n}`;
};

describe("applyRevisions", () => {
  it("rewrites the summary", () => {
    const r = applyRevisions(artifact(), [{ kind: "summary", body: "What I actually verified." }]);
    expect(r.artifact.summary).toBe("What I actually verified.");
    expect(r.applied).toHaveLength(1);
    expect(r.refused).toHaveLength(0);
  });

  it("replaces the verdict", () => {
    const r = applyRevisions(artifact(), [
      { kind: "verdict", verdict: { recommendation: "approve", confidence: 90, reasoning: "read it" } },
    ]);
    expect(r.artifact.verdict).toEqual({ recommendation: "approve", confidence: 90, reasoning: "read it" });
  });

  it("rewrites a chapter, leaving the fields it did not mention alone", () => {
    const r = applyRevisions(artifact(), [
      { kind: "chapter", chapterId: "one", explanation: "Clearer now." },
    ]);
    expect(r.artifact.chapters[0]).toMatchObject({
      title: "One",
      explanation: "Clearer now.",
      files: ["src/a.ts"],
    });
  });

  it("edits an AI comment", () => {
    const r = applyRevisions(artifact(), [{ kind: "comment-edit", commentId: "c1", body: "Sharper." }]);
    expect(r.artifact.comments[0]!.body).toBe("Sharper.");
  });

  it("drops a comment by marking it dropped, not by deleting it", () => {
    // Send already reads `status`, and the cockpit strikes a dropped comment
    // through — deleting the row would lose the record that it was ever made.
    const r = applyRevisions(artifact(), [{ kind: "comment-drop", commentId: "c1" }]);
    expect(r.artifact.comments).toHaveLength(1);
    expect(r.artifact.comments[0]!.status).toBe("dropped");
  });

  it("adds a comment as an AI draft", () => {
    const r = applyRevisions(
      artifact(),
      [{ kind: "comment-add", path: "src/b.ts", line: 3, body: "Missed this.", chapterId: null }],
      { newId: ids() },
    );
    expect(r.artifact.comments).toHaveLength(2);
    expect(r.artifact.comments[1]).toMatchObject({
      id: "new-1",
      path: "src/b.ts",
      line: 3,
      origin: "ai",
      status: "draft",
      editedByUser: false,
    });
  });

  it("applies several revisions in one turn, in order", () => {
    const r = applyRevisions(
      artifact(),
      [
        { kind: "summary", body: "Rewritten." },
        { kind: "comment-drop", commentId: "c1" },
        { kind: "comment-add", path: "src/b.ts", line: null, body: "File-level.", chapterId: "one" },
      ],
      { newId: ids() },
    );
    expect(r.artifact.summary).toBe("Rewritten.");
    expect(r.artifact.comments[0]!.status).toBe("dropped");
    expect(r.artifact.comments[1]!.line).toBeNull();
    expect(r.applied).toHaveLength(3);
  });

  describe("the user's own words", () => {
    it("refuses to rewrite a comment the user wrote", () => {
      const a = artifact({ comments: [comment({ origin: "user", body: "Mine." })] });
      const r = applyRevisions(a, [{ kind: "comment-edit", commentId: "c1", body: "Not yours." }]);
      expect(r.artifact.comments[0]!.body).toBe("Mine.");
      expect(r.applied).toHaveLength(0);
      expect(r.refused[0]!.reason).toMatch(/user's own writing/);
    });

    it("refuses to rewrite an AI comment the user edited", () => {
      const a = artifact({ comments: [comment({ editedByUser: true, body: "My rewrite." })] });
      const r = applyRevisions(a, [{ kind: "comment-edit", commentId: "c1", body: "Undone." }]);
      expect(r.artifact.comments[0]!.body).toBe("My rewrite.");
      expect(r.refused).toHaveLength(1);
    });

    it("refuses to drop the user's comment too", () => {
      const a = artifact({ comments: [comment({ origin: "user" })] });
      const r = applyRevisions(a, [{ kind: "comment-drop", commentId: "c1" }]);
      expect(r.artifact.comments[0]!.status).toBe("draft");
      expect(r.refused[0]!.reason).toMatch(/ask before dropping/);
    });

    it("does it anyway once the user has said so", () => {
      const a = artifact({ comments: [comment({ origin: "user", body: "Mine." })] });
      const r = applyRevisions(a, [{ kind: "comment-edit", commentId: "c1", body: "As asked." }], {
        allowUserComments: true,
      });
      expect(r.artifact.comments[0]!.body).toBe("As asked.");
      expect(r.refused).toHaveLength(0);
    });
  });

  describe("targets that do not exist", () => {
    it("refuses an unknown chapter rather than inventing one", () => {
      const r = applyRevisions(artifact(), [{ kind: "chapter", chapterId: "nope", title: "X" }]);
      expect(r.artifact.chapters).toHaveLength(1);
      expect(r.refused[0]!.reason).toMatch(/no chapter/);
    });

    it("refuses an unknown comment", () => {
      const r = applyRevisions(artifact(), [{ kind: "comment-edit", commentId: "nope", body: "X" }]);
      expect(r.refused[0]!.reason).toMatch(/no comment/);
    });

    it("keeps applying the rest of the turn after a refusal", () => {
      const r = applyRevisions(artifact(), [
        { kind: "comment-edit", commentId: "nope", body: "X" },
        { kind: "summary", body: "Still landed." },
      ]);
      expect(r.artifact.summary).toBe("Still landed.");
      expect(r.applied).toHaveLength(1);
      expect(r.refused).toHaveLength(1);
    });
  });

  it("leaves the input artifact untouched", () => {
    const a = artifact();
    applyRevisions(a, [{ kind: "summary", body: "Changed." }]);
    expect(a.summary).toBe("The original summary.");
  });
});

describe("mergeConcurrentEdits", () => {
  // A turn takes minutes. The cockpit stays live, so the user can be editing
  // while the answer is still being written.
  const before = () => artifact({ comments: [comment({ id: "c1", body: "AI wrote this." })] });

  it("keeps a comment the user edited while the turn was running", () => {
    const b = before();
    const { artifact: after } = applyRevisions(b, [
      { kind: "comment-edit", commentId: "c1", body: "The turn's rewrite." },
    ]);
    const current = artifact({ comments: [comment({ id: "c1", body: "The user's own rewrite.", editedByUser: true })] });
    const merged = mergeConcurrentEdits(b, after, current);
    expect(merged.comments[0]!.body).toBe("The user's own rewrite.");
  });

  it("takes the turn's rewrite when the user did not touch it", () => {
    const b = before();
    const { artifact: after } = applyRevisions(b, [
      { kind: "comment-edit", commentId: "c1", body: "The turn's rewrite." },
    ]);
    const merged = mergeConcurrentEdits(b, after, artifact({ comments: [comment({ id: "c1" })] }));
    expect(merged.comments[0]!.body).toBe("The turn's rewrite.");
  });

  it("keeps a comment the user dropped while the turn was running", () => {
    const b = before();
    const { artifact: after } = applyRevisions(b, [
      { kind: "comment-edit", commentId: "c1", body: "Sharper." },
    ]);
    const current = artifact({ comments: [comment({ id: "c1", status: "dropped" })] });
    expect(mergeConcurrentEdits(b, after, current).comments[0]!.status).toBe("dropped");
  });

  it("does not resurrect a comment the user deleted while the turn was running", () => {
    // Delete removes the row outright (unlike drop, which marks it), so the
    // turn's copy is the only one left — pushing it back would undo the
    // deletion, which is exactly what this function exists to prevent.
    const b = before();
    const merged = mergeConcurrentEdits(b, b, artifact({ comments: [] }));
    expect(merged.comments).toEqual([]);
  });

  it("keeps a comment the user added while the turn was running", () => {
    const b = before();
    const current = artifact({
      comments: [comment({ id: "c1" }), comment({ id: "mine", origin: "user", body: "Spotted this." })],
    });
    const merged = mergeConcurrentEdits(b, b, current);
    expect(merged.comments.map((c) => c.id)).toEqual(["c1", "mine"]);
  });

  it("keeps a comment the turn added", () => {
    const b = before();
    const { artifact: after } = applyRevisions(
      b,
      [{ kind: "comment-add", path: "src/b.ts", line: 1, body: "New.", chapterId: null }],
      { newId: ids() },
    );
    const merged = mergeConcurrentEdits(b, after, artifact({ comments: [comment({ id: "c1" })] }));
    expect(merged.comments.map((c) => c.id)).toEqual(["c1", "new-1"]);
  });

  it("keeps a queue status the user set while the turn was running", () => {
    const b = before();
    const { artifact: after } = applyRevisions(b, [{ kind: "summary", body: "x" }]);
    const current = artifact({ ...b, status: "reviewed" });
    expect(mergeConcurrentEdits(b, after, current).status).toBe("reviewed");
  });

  it("keeps a verdict override the user set, when the turn did not touch the verdict", () => {
    const b = before();
    const { artifact: after } = applyRevisions(b, [{ kind: "summary", body: "x" }]);
    const mine = { recommendation: "approve" as const, confidence: 70, reasoning: "because" };
    const merged = mergeConcurrentEdits(b, after, artifact({ ...b, verdict: mine }));
    expect(merged.verdict).toEqual(mine);
  });

  it("takes the turn's verdict when the turn did revise it", () => {
    const b = before();
    const theirs = { recommendation: "request_changes" as const, confidence: 80, reasoning: "found one" };
    const { artifact: after } = applyRevisions(b, [{ kind: "verdict", verdict: theirs }]);
    const merged = mergeConcurrentEdits(b, after, artifact({ ...b, verdict: null }));
    expect(merged.verdict).toEqual(theirs);
  });

  it("takes the turn's summary, chapters and verdict", () => {
    // Only comments are editable in the cockpit while a turn runs, so the rest
    // of the review has no concurrent writer to lose to.
    const b = before();
    const { artifact: after } = applyRevisions(b, [{ kind: "summary", body: "The turn's summary." }]);
    const merged = mergeConcurrentEdits(b, after, artifact({ summary: "stale" }));
    expect(merged.summary).toBe("The turn's summary.");
  });
});

describe("snapshot and restore", () => {
  it("puts the review back the way it was", () => {
    const before = artifact();
    const snap = snapshotReview(before, "2026-08-19T01:00:00Z");
    const { artifact: after } = applyRevisions(before, [
      { kind: "summary", body: "Argued into something else." },
      { kind: "comment-drop", commentId: "c1" },
    ]);
    const back = restoreReview(after, snap);
    expect(back.summary).toBe("The original summary.");
    expect(back.comments[0]!.status).toBe("draft");
  });

  it("keeps the conversation when the review is reset", () => {
    // Reset undoes the edits, not the argument that produced them — otherwise
    // you lose the reasoning along with the result.
    const snap = snapshotReview(artifact(), "2026-08-19T01:00:00Z");
    const chatted = artifact({
      summary: "Changed.",
      chat: [{ id: "t1", role: "user", at: "x", body: "hi", refs: [], revisions: [], refused: [], costUsd: null }],
    });
    expect(restoreReview(chatted, snap).chat).toHaveLength(1);
  });
});
