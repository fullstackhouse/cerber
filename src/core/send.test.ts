import { describe, expect, it } from "vitest";
import { Artifact } from "./artifact.js";
import { newSideLines } from "./diff.js";
import { toMarkdown } from "./export.js";
import { buildReviewPayload, eventForRecommendation } from "./send.js";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1;
+const b = 2;
 export { a };
 // end
`;

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    schemaVersion: 1,
    id: "o/r#1",
    status: "ready",
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
      headSha: "abc",
      additions: 1,
      deletions: 0,
      changedFiles: 1,
    },
    diff: DIFF,
    summary: "Adds b.",
    chapters: [{ id: "core", title: "Core", explanation: "Adds a const.", files: ["src/a.ts"] }],
    comments: [],
    verdict: { recommendation: "comment", confidence: 80, reasoning: "ok" },
    run: null,
    sent: null,
    calibration: null,
    ...overrides,
  };
}

describe("newSideLines", () => {
  it("collects new-side line numbers from hunks", () => {
    const lines = newSideLines(DIFF).get("src/a.ts")!;
    expect(lines.has(1)).toBe(true); // context
    expect(lines.has(2)).toBe(true); // added
    expect(lines.has(4)).toBe(true); // last context line
    expect(lines.has(5)).toBe(false); // beyond the hunk
  });
});

describe("buildReviewPayload", () => {
  it("sends anchorable comments inline and folds the rest into the body", () => {
    const artifact = makeArtifact({
      comments: [
        { id: "1", path: "src/a.ts", line: 2, body: "inline ok", chapterId: "core", origin: "ai", status: "draft", editedByUser: false },
        { id: "2", path: "src/a.ts", line: 999, body: "bad line", chapterId: "core", origin: "ai", status: "draft", editedByUser: false },
        { id: "3", path: "src/a.ts", line: null, body: "file-level", chapterId: null, origin: "user", status: "approved", editedByUser: false },
        { id: "4", path: "src/a.ts", line: 2, body: "dropped!", chapterId: null, origin: "ai", status: "dropped", editedByUser: false },
      ],
    });
    const payload = buildReviewPayload(artifact, "COMMENT");
    expect(payload.comments).toEqual([{ path: "src/a.ts", line: 2, side: "RIGHT", body: "inline ok" }]);
    expect(payload.folded.map((c) => c.id)).toEqual(["2", "3"]);
    expect(payload.body).toContain("bad line");
    expect(payload.body).toContain("file-level");
    expect(payload.body).not.toContain("dropped!");
    expect(payload.body).toContain("## Summary");
    expect(payload.body).toContain("## Walkthrough");
    expect(payload.body).toContain("cerber");
  });

  it("anchors the review to the reviewed head commit", () => {
    expect(buildReviewPayload(makeArtifact(), "COMMENT").commitId).toBe("abc");
    const noSha = makeArtifact({ pr: { ...makeArtifact().pr, headSha: "" } });
    expect(buildReviewPayload(noSha, "COMMENT").commitId).toBeUndefined();
  });

  it("maps recommendations to events", () => {
    expect(eventForRecommendation("approve")).toBe("APPROVE");
    expect(eventForRecommendation("comment")).toBe("COMMENT");
    expect(eventForRecommendation("request_changes")).toBe("REQUEST_CHANGES");
  });
});

describe("toMarkdown", () => {
  it("renders a full review document without dropped comments", () => {
    const artifact = makeArtifact({
      comments: [
        { id: "1", path: "src/a.ts", line: 2, body: "note", chapterId: "core", origin: "ai", status: "draft", editedByUser: false },
        { id: "2", path: "src/a.ts", line: 3, body: "hidden", chapterId: "core", origin: "ai", status: "dropped", editedByUser: false },
      ],
    });
    const md = toMarkdown(artifact);
    expect(md).toContain("# Review: o/r#1");
    expect(md).toContain("**Verdict: comment**");
    expect(md).toContain("### Core");
    expect(md).toContain("src/a.ts:2");
    expect(md).not.toContain("hidden");
  });
});
