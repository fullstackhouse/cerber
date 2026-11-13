import { describe, expect, it } from "vitest";
import { html } from "diff2html";
import { groupChangedRows } from "./diffrows";

const render = (patch: string) =>
  groupChangedRows(html(patch, { drawFileList: false, matching: "lines", outputFormat: "line-by-line" }));

/** The prefix and text of every code row, in display order. */
const lines = (out: string) =>
  [...out.matchAll(/<span class="d2h-code-line-prefix">([^<]*)<\/span>\s*<span class="d2h-code-line-ctn">([\s\S]*?)<\/span>\s*<\/div>/g)].map(
    (m) => `${m[1] === "&nbsp;" ? " " : m[1]}${m[2]!.replace(/<\/?(ins|del)>/g, "")}`,
  );

describe("groupChangedRows", () => {
  it("shows a rewritten block as all removals, then all additions", () => {
    const patch = [
      "diff --git a/x.md b/x.md",
      "--- a/x.md",
      "+++ b/x.md",
      "@@ -1,5 +1,5 @@",
      " ctx",
      "-alpha beta gamma",
      "-delta epsilon zeta",
      "-eta theta iota",
      "+alpha beta GAMMA",
      "+delta EPSILON zeta",
      "+eta theta IOTA",
      " end",
      "",
    ].join("\n");
    expect(lines(render(patch))).toEqual([
      " ctx",
      "-alpha beta gamma",
      "-delta epsilon zeta",
      "-eta theta iota",
      "+alpha beta GAMMA",
      "+delta EPSILON zeta",
      "+eta theta IOTA",
      " end",
    ]);
  });

  it("keeps the word marks from the line matching", () => {
    const patch = [
      "diff --git a/x.md b/x.md",
      "--- a/x.md",
      "+++ b/x.md",
      "@@ -1,2 +1,2 @@",
      "-alpha beta gamma",
      "-delta epsilon",
      "+alpha beta GAMMA",
      "+delta EPSILON",
      "",
    ].join("\n");
    const out = render(patch);
    expect(out).toContain("<del>gamma</del>");
    expect(out).toContain("<ins>EPSILON</ins>");
  });

  it("does not move a change across context or a hunk header", () => {
    const patch = [
      "diff --git a/x.md b/x.md",
      "--- a/x.md",
      "+++ b/x.md",
      "@@ -1,3 +1,3 @@",
      "-one",
      "+ONE",
      " mid",
      "-two",
      "+TWO",
      "@@ -10,1 +10,1 @@",
      "-ten",
      "+TEN",
      "",
    ].join("\n");
    expect(lines(render(patch))).toEqual(["-one", "+ONE", " mid", "-two", "+TWO", "-ten", "+TEN"]);
  });
});
