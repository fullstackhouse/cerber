import { describe, expect, it } from "vitest";
import { Artifact } from "./artifact.js";
import { newSideLines } from "./diff.js";
import { toMarkdown } from "./export.js";
import { buildReviewPayload, describeReplyFailures, eventForRecommendation, recordReplies } from "./send.js";
import { AlreadyRaised, Comment } from "./artifact.js";

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
      state: "OPEN" as const,
      isDraft: false,
      additions: 1,
      deletions: 0,
      changedFiles: 1,
    },
    diff: DIFF,
    summary: "Adds b.",
    chapters: [{ id: "core", title: "Core", explanation: "Adds a const.", files: ["src/a.ts"] }],
    comments: [],
    verdict: { recommendation: "comment", confidence: 80, reasoning: "ok" },
    bodyOverride: null,
    run: null,
    sent: null,
    refresh: null,
    filed: null,
    handoff: null,
    raisedCheck: null,
    settledAt: null,
    calibration: null,
    chat: [],
    preChat: null,
    pendingChat: null,
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
        { id: "1", path: "src/a.ts", line: 2, body: "inline ok", chapterId: "core", severity: null, origin: "ai", status: "draft", editedByUser: false, originalLine: null, drifted: false, alreadyRaised: null },
        { id: "2", path: "src/a.ts", line: 999, body: "bad line", chapterId: "core", severity: null, origin: "ai", status: "draft", editedByUser: false, originalLine: null, drifted: false, alreadyRaised: null },
        { id: "3", path: "src/a.ts", line: null, body: "file-level", chapterId: null, severity: null, origin: "user", status: "approved", editedByUser: false, originalLine: null, drifted: false, alreadyRaised: null },
        { id: "4", path: "src/a.ts", line: 2, body: "dropped!", chapterId: null, severity: null, origin: "ai", status: "dropped", editedByUser: false, originalLine: null, drifted: false, alreadyRaised: null },
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

  it("badges graded comments, inline and folded, and leaves ungraded ones bare", () => {
    const artifact = makeArtifact({
      comments: [
        { id: "1", path: "src/a.ts", line: 2, body: "will corrupt state", chapterId: null, severity: "blocker", origin: "ai", status: "draft", editedByUser: false, originalLine: null, drifted: false, alreadyRaised: null },
        { id: "2", path: "src/a.ts", line: 999, body: "typo in the name", chapterId: null, severity: "nit", origin: "ai", status: "draft", editedByUser: false, originalLine: null, drifted: false, alreadyRaised: null },
        { id: "3", path: "src/a.ts", line: null, body: "why this order?", chapterId: null, severity: null, origin: "ai", status: "draft", editedByUser: false, originalLine: null, drifted: false, alreadyRaised: null },
      ],
    });
    const payload = buildReviewPayload(artifact, "COMMENT");
    expect(payload.comments[0]!.body).toBe("🚨 **blocker** — will corrupt state");
    expect(payload.body).toContain("🎨 **nit** — typo in the name");
    expect(payload.body).toContain("— why this order?");
    expect(payload.body).not.toContain("null");
  });

  it("folds drifted comments even when their line still exists", () => {
    // Line 2 is in the diff, but the code the comment was written about is
    // gone — posting inline would attach it to whatever took that line over.
    const artifact = makeArtifact({
      comments: [
        { id: "1", path: "src/a.ts", line: 2, body: "stale anchor", chapterId: "core", severity: null, origin: "ai", status: "draft", editedByUser: false, originalLine: null, drifted: true, alreadyRaised: null },
      ],
    });
    const payload = buildReviewPayload(artifact, "COMMENT");
    expect(payload.comments).toEqual([]);
    expect(payload.folded.map((c) => c.id)).toEqual(["1"]);
    expect(payload.body).toContain("src/a.ts:~2");
  });

  it("posts the body the user wrote instead of the composed one", () => {
    // The whole body, footer included: a body half-honoured is one nobody
    // wrote. The draft underneath is untouched — only what posts changed.
    const artifact = makeArtifact({
      bodyOverride: "Looks good to me. I ran the migration locally.\n",
      comments: [
        { id: "1", path: "src/a.ts", line: 2, body: "inline ok", chapterId: "core", severity: null, origin: "ai", status: "draft", editedByUser: false, originalLine: null, drifted: false, alreadyRaised: null },
        { id: "2", path: "src/a.ts", line: 999, body: "bad line", chapterId: "core", severity: null, origin: "ai", status: "draft", editedByUser: false, originalLine: null, drifted: false, alreadyRaised: null },
      ],
    });
    const payload = buildReviewPayload(artifact, "APPROVE");
    // Verbatim, trailing newline and all: the panel says this is exactly what
    // posts, and a body that opens on an indented line is a markdown code
    // block — trimming it would silently repaint it as a paragraph.
    expect(payload.body).toBe("Looks good to me. I ran the migration locally.\n");
    expect(payload.body).not.toContain("## Summary");
    expect(payload.body).not.toContain("cerber");
    // Inline comments are a separate half of the payload and still post, and
    // the cockpit still needs to know which comments had no line to land on.
    expect(payload.comments).toEqual([{ path: "src/a.ts", line: 2, side: "RIGHT", body: "inline ok" }]);
    expect(payload.folded.map((c) => c.id)).toEqual(["2"]);
  });

  it("keeps a body that opens on an indented code block", () => {
    const body = "    const a = 1;\n\nThat is all it needed.\n";
    expect(buildReviewPayload(makeArtifact({ bodyOverride: body }), "COMMENT").body).toBe(body);
  });

  it("composes the body again once the override is cleared", () => {
    const payload = buildReviewPayload(makeArtifact({ bodyOverride: null }), "COMMENT");
    expect(payload.body).toContain("## Summary");
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
        { id: "1", path: "src/a.ts", line: 2, body: "note", chapterId: "core", severity: null, origin: "ai", status: "draft", editedByUser: false, originalLine: null, drifted: false, alreadyRaised: null },
        { id: "2", path: "src/a.ts", line: 3, body: "hidden", chapterId: "core", severity: null, origin: "ai", status: "dropped", editedByUser: false, originalLine: null, drifted: false, alreadyRaised: null },
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

describe("findings somebody else already raised", () => {
  const thread = (over: Partial<AlreadyRaised> = {}, state: "open" | "resolved" = "open"): AlreadyRaised => ({
    remarkId: "T_1",
    by: "a-bot[bot]",
    at: "2026-09-30T10:00:00Z",
    url: "https://gh/t/1",
    where: { kind: "thread", path: "src/a.ts", line: 2, state, replyTo: "4100000001" },
    reason: "same double count",
    decision: null,
    replied: null,
    ...over,
  });
  const finding = (id: string, alreadyRaised: AlreadyRaised | null): Comment => ({
    id, path: "src/a.ts", line: 2, body: `finding ${id}`, chapterId: "core", severity: "minor",
    origin: "ai", status: "draft", editedByUser: false, originalLine: null, drifted: false, alreadyRaised,
  });

  it("holds an undecided duplicate out of the review, inline and body alike", () => {
    const payload = buildReviewPayload(
      makeArtifact({ comments: [finding("dup", thread()), { ...finding("dup-file", thread()), line: null }] }),
      "COMMENT",
    );
    expect(payload.comments).toEqual([]);
    expect(payload.folded).toEqual([]);
    expect(payload.body).not.toContain("finding dup");
    expect(payload.held.map((c) => c.id)).toEqual(["dup", "dup-file"]);
  });

  it("answers in their thread when the user chose to, with the grade on it", () => {
    const payload = buildReviewPayload(
      makeArtifact({ comments: [finding("r", thread({ decision: "reply" }))] }),
      "COMMENT",
    );
    expect(payload.comments).toEqual([]);
    expect(payload.replies).toEqual([{ commentId: "r", replyTo: "4100000001", body: "⚠️ **minor** — finding r" }]);
  });

  it("posts as usual on 'send anyway', and on a resolved thread nobody decided about", () => {
    const payload = buildReviewPayload(
      makeArtifact({
        comments: [finding("anyway", thread({ decision: "send" })), finding("resolved", thread({}, "resolved"))],
      }),
      "COMMENT",
    );
    expect(payload.comments.map((c) => c.body)).toEqual(["⚠️ **minor** — finding anyway", "⚠️ **minor** — finding resolved"]);
    expect(payload.held).toEqual([]);
  });

  it("records the replies that posted, and says which did not", () => {
    const artifact = makeArtifact({
      comments: [finding("ok", thread({ decision: "reply" })), finding("bad", thread({ decision: "reply" }))],
    });
    const outcomes = [
      { commentId: "ok", at: "t", url: "https://gh/reply/1", error: null },
      { commentId: "bad", at: "t", url: null, error: "HTTP 404" },
    ];
    const recorded = recordReplies(artifact, outcomes);
    expect(recorded.comments.map((c) => c.alreadyRaised?.replied)).toEqual([
      { at: "t", url: "https://gh/reply/1" },
      null,
    ]);
    expect(describeReplyFailures(outcomes)).toBe("1 reply in an existing thread did not post: HTTP 404");
    expect(describeReplyFailures([outcomes[0]!])).toBeNull();
  });

  it("says in the export who raised it first", () => {
    const md = toMarkdown(makeArtifact({ comments: [finding("dup", thread())] }));
    expect(md).toContain("Already raised by @a-bot[bot]: same double count");
  });
});
