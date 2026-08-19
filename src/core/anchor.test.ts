import { describe, expect, it } from "vitest";
import { reanchorComments } from "./anchor.js";
import { Comment } from "./artifact.js";
import { newSideLineText } from "./diff.js";

function comment(overrides: Partial<Comment> & Pick<Comment, "id" | "path" | "line">): Comment {
  return {
    body: "note",
    chapterId: null,
    origin: "ai",
    status: "draft",
    editedByUser: false,
    originalLine: null,
    drifted: false,
    ...overrides,
  };
}

/** Same file, but the hunk starts 10 lines later — every line shifts by 10. */
const BEFORE = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 const a = 1;
+const b = 2;
 const c = 3;
 export { a };
`;

const AFTER_SHIFTED = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -11,4 +11,5 @@
 const a = 1;
+const b = 2;
 const c = 3;
 export { a };
`;

const AFTER_REWRITTEN = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 const a = 1;
+const b = 42;
 const c = 3;
 export { a };
`;

describe("newSideLineText", () => {
  it("maps new-side line numbers to their code", () => {
    const lines = newSideLineText(BEFORE).get("src/a.ts")!;
    expect(lines.get(1)).toBe("const a = 1;");
    expect(lines.get(2)).toBe("const b = 2;");
    expect(lines.get(4)).toBe("export { a };");
    expect(lines.has(5)).toBe(false);
  });
});

describe("reanchorComments", () => {
  it("follows code that moved to a new line", () => {
    const c = comment({ id: "1", path: "src/a.ts", line: 2 });
    const { comments, results, moved, drifted } = reanchorComments([c], BEFORE, AFTER_SHIFTED);
    expect(results[0]!.state).toBe("moved");
    expect(comments[0]!.line).toBe(12);
    expect(comments[0]!.originalLine).toBe(2);
    expect(comments[0]!.drifted).toBe(false);
    expect([moved, drifted]).toEqual([1, 0]);
  });

  it("leaves untouched code alone", () => {
    const c = comment({ id: "1", path: "src/a.ts", line: 2 });
    const { comments, results } = reanchorComments([c], BEFORE, BEFORE);
    expect(results[0]!.state).toBe("unchanged");
    expect(comments[0]).toBe(c);
  });

  it("marks a comment drifted when its code is gone", () => {
    const c = comment({ id: "1", path: "src/a.ts", line: 2 });
    const { comments, results, drifted } = reanchorComments([c], BEFORE, AFTER_REWRITTEN);
    expect(results[0]!.state).toBe("drifted");
    expect(comments[0]!.drifted).toBe(true);
    // The stale line is kept: it's the only trace of what the comment was about.
    expect(comments[0]!.line).toBe(2);
    expect(drifted).toBe(1);
  });

  it("marks a comment drifted when its file left the diff", () => {
    const c = comment({ id: "1", path: "src/gone.ts", line: 2 });
    const { results } = reanchorComments([c], BEFORE, AFTER_SHIFTED);
    expect(results[0]!.state).toBe("drifted");
  });

  it("leaves file-level comments alone", () => {
    const c = comment({ id: "1", path: "src/a.ts", line: null });
    const { comments, results } = reanchorComments([c], BEFORE, AFTER_SHIFTED);
    expect(results[0]!.state).toBe("unanchored");
    expect(comments[0]!.line).toBeNull();
  });

  it("clears a drift flag when the code comes back", () => {
    const c = comment({ id: "1", path: "src/a.ts", line: 2, drifted: true });
    const { comments } = reanchorComments([c], BEFORE, BEFORE);
    expect(comments[0]!.drifted).toBe(false);
  });

  it("uses surrounding lines to pick between identical candidates", () => {
    const before = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 function first() {
   return 1;
 }
`;
    // Two "  return 1;" lines now; only one kept the same neighbours.
    const after = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,7 @@
 function zeroth() {
   compute();
   return 1;
 }
 function first() {
   return 1;
 }
`;
    const c = comment({ id: "1", path: "src/a.ts", line: 2 });
    const { comments, results } = reanchorComments([c], before, after);
    expect(results[0]!.state).toBe("moved");
    expect(comments[0]!.line).toBe(6);
  });

  it("refuses to guess when the candidates are truly ambiguous", () => {
    const before = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 x();
 }
 x();
`;
    // Three identical blocks: the neighbours can't break the tie either.
    const after = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,8 +1,8 @@
 top();
 x();
 }
 x();
 }
 x();
 }
 x();
`;
    const c = comment({ id: "1", path: "src/a.ts", line: 2 });
    const { results, comments } = reanchorComments([c], before, after);
    expect(results[0]!.state).toBe("drifted");
    expect(comments[0]!.drifted).toBe(true);
  });

  it("keeps a comment put when the same line still holds the same code", () => {
    // The fast path: identical text at the identical line number wins, even if
    // the file changed elsewhere. Anything stricter would flag benign edits.
    const c = comment({ id: "1", path: "src/a.ts", line: 1 });
    const { results } = reanchorComments([c], BEFORE, AFTER_REWRITTEN);
    expect(results[0]!.state).toBe("unchanged");
  });
});
