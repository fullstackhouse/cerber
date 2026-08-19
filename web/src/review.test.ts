import { describe, expect, it } from "vitest";
import { buildReviewPayload } from "../../src/core/send";
import { Artifact as CoreArtifact } from "../../src/core/artifact";
import { eventForVerdict, payloadSummary, splitComments } from "./review";
import { Artifact, ReviewComment } from "./types";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1;
+const b = 2;
 const c = 3;
`;

const comment = (over: Partial<ReviewComment> = {}): ReviewComment => ({
  id: "c1",
  path: "src/a.ts",
  line: 2,
  body: "a note",
  chapterId: "ch1",
  origin: "ai",
  status: "draft",
  ...over,
});

const artifact = (comments: ReviewComment[]): Artifact =>
  ({
    schemaVersion: 1,
    id: "acme/web#1",
    status: "ready",
    createdAt: "2026-08-19T12:00:00.000Z",
    updatedAt: "2026-08-19T12:00:00.000Z",
    pr: {
      title: "a change",
      url: "",
      author: "mira",
      owner: "acme",
      repo: "web",
      number: 1,
      body: "",
      baseRefName: "main",
      headRefName: "feat/x",
      headSha: "abc1234",
      additions: 1,
      deletions: 0,
      changedFiles: 1,
    },
    diff: DIFF,
    summary: "",
    chapters: [],
    comments,
    verdict: null,
    run: null,
    sent: null,
  }) as Artifact;

describe("eventForVerdict", () => {
  it("maps a verdict onto the GitHub event it asks for", () => {
    expect(eventForVerdict({ recommendation: "approve", confidence: 9, reasoning: "" })).toBe("APPROVE");
    expect(eventForVerdict({ recommendation: "request_changes", confidence: 9, reasoning: "" })).toBe(
      "REQUEST_CHANGES",
    );
    expect(eventForVerdict({ recommendation: "comment", confidence: 9, reasoning: "" })).toBe("COMMENT");
    expect(eventForVerdict(null)).toBe("COMMENT");
  });
});

describe("splitComments", () => {
  it("anchors a comment on a line the diff added", () => {
    const { inline, folded, dropped } = splitComments(artifact([comment()]));
    expect(inline.map((c) => c.id)).toEqual(["c1"]);
    expect(folded).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it("folds a comment whose code drifted out from under it", () => {
    const { inline, folded } = splitComments(artifact([comment({ drifted: true })]));
    expect(inline).toEqual([]);
    expect(folded.map((c) => c.id)).toEqual(["c1"]);
  });

  it("folds a comment on a line the diff never touched", () => {
    const { folded } = splitComments(artifact([comment({ line: 900 })]));
    expect(folded.map((c) => c.id)).toEqual(["c1"]);
  });

  it("keeps dropped comments out of both — they never post", () => {
    const { inline, folded, dropped } = splitComments(artifact([comment({ status: "dropped" })]));
    expect(inline).toEqual([]);
    expect(folded).toEqual([]);
    expect(dropped.map((c) => c.id)).toEqual(["c1"]);
  });

  // The cockpit states what send will do before send runs; if this drifts from
  // buildReviewPayload the panel promises something else than it posts.
  it("agrees with the payload the send path actually builds", () => {
    const comments = [
      comment({ id: "inline" }),
      comment({ id: "drift", drifted: true }),
      comment({ id: "off", line: null }),
      comment({ id: "gone", status: "dropped" }),
    ];
    const a = artifact(comments);
    const payload = buildReviewPayload(a as unknown as CoreArtifact, "COMMENT");
    const split = splitComments(a);
    expect(split.inline.length).toBe(payload.comments.length);
    expect(split.folded.map((c) => c.id)).toEqual(payload.folded.map((c) => c.id));
  });
});

describe("payloadSummary", () => {
  it("says what will land on the PR, in the shapes it can land in", () => {
    expect(payloadSummary(artifact([]))).toBe("no inline comments · body only");
    expect(payloadSummary(artifact([comment()]))).toBe("1 inline");
    expect(payloadSummary(artifact([comment(), comment({ id: "c2", line: null })]))).toBe(
      "1 inline · 1 folded into the body",
    );
  });
});
