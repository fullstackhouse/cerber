import { describe, expect, it } from "vitest";
import { Artifact, Comment } from "./artifact.js";
import { carryOverComments, refreshArtifact } from "./refresh.js";

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

describe("carryOverComments", () => {
  const previous = makeArtifact({
    comments: [
      comment({ id: "ai-untouched", origin: "ai" }),
      comment({ id: "ai-edited", origin: "ai", editedByUser: true, body: "my rewrite" }),
      comment({ id: "mine", origin: "user", body: "my own note" }),
      comment({ id: "mine-dropped", origin: "user", status: "dropped" }),
    ],
  });
  const fresh = makeArtifact({
    diff: DIFF_AT_HEAD2,
    comments: [comment({ id: "ai-new", body: "fresh ai comment" })],
  });

  it("keeps the human's comments and drops the regenerated AI ones", () => {
    const { comments, carried } = carryOverComments(previous, fresh);
    expect(carried).toBe(3);
    expect(comments.map((c) => c.id)).toEqual(["ai-new", "ai-edited", "mine", "mine-dropped"]);
    expect(comments.find((c) => c.id === "ai-edited")!.body).toBe("my rewrite");
    expect(comments.find((c) => c.id === "mine-dropped")!.status).toBe("dropped");
  });

  it("re-anchors what it carries to the new diff", () => {
    const { comments } = carryOverComments(previous, fresh);
    expect(comments.find((c) => c.id === "mine")!.line).toBe(12);
  });

  it("leaves a review with no human input alone", () => {
    const untouched = makeArtifact({ comments: [comment({ id: "ai-1" })] });
    const { comments, carried } = carryOverComments(untouched, fresh);
    expect(carried).toBe(0);
    expect(comments).toBe(fresh.comments);
  });

  it("carries a comment's severity across a re-review", () => {
    const graded = makeArtifact({
      comments: [comment({ id: "mine", origin: "user", severity: "blocker" })],
    });
    const { comments } = carryOverComments(graded, fresh);
    expect(comments.find((c) => c.id === "mine")!.severity).toBe("blocker");
  });
});
