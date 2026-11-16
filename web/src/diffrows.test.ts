import { describe, expect, it } from "vitest";
import { html } from "diff2html";
import { splitDiffByFile } from "../../src/core/diff";
import { describeFiles, groupChangedRows } from "./diffrows";

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

  it("draws every removal red and every addition green, paired or not", () => {
    const patch = [
      "diff --git a/x.md b/x.md",
      "--- a/x.md",
      "+++ b/x.md",
      "@@ -1,3 +1,1 @@",
      "-alpha beta gamma",
      "-something else entirely",
      "-and one more",
      "+alpha beta GAMMA",
      "",
    ].join("\n");
    const out = render(patch);
    expect(out).not.toMatch(/class="[^"]*\bd2h-change\b/);
    expect(out).toContain("<del>gamma</del>");
  });

  it("drops word marks that cover most of a pair, as rewrapped prose gets", () => {
    const patch = [
      "diff --git a/x.md b/x.md",
      "--- a/x.md",
      "+++ b/x.md",
      "@@ -1,2 +1,2 @@",
      "-  kind declares that the kind carries a party id and every",
      "-  row whose parent is one of them. Such a row is readable",
      "+  kind says so: it registers an action-log read rule naming the",
      "+  whose rows are the record, the parent kinds whose child rows",
      "",
    ].join("\n");
    const out = render(patch);
    expect(out).not.toMatch(/<(ins|del)>/);
    expect(lines(out)).toEqual([
      "-  kind declares that the kind carries a party id and every",
      "-  row whose parent is one of them. Such a row is readable",
      "+  kind says so: it registers an action-log read rule naming the",
      "+  whose rows are the record, the parent kinds whose child rows",
    ]);
  });

  it("finds a pair that is not two adjacent rows, as with lines past 200 characters", () => {
    const long = (s: string) => `${s} `.repeat(12).trim();
    const old1 = long("kind declares that the kind carries a party id and every row whose parent");
    const old2 = long("party has a row of that role, live or soft-deleted after the customer is gone");
    const new1 = long("kind says so: it registers an action-log read rule naming the kinds of rows");
    const new2 = long("without that feature does not get those rows: not with view tenant either");
    const patch = [
      "diff --git a/x.md b/x.md",
      "--- a/x.md",
      "+++ b/x.md",
      "@@ -1,2 +1,2 @@",
      `-${old1}`,
      `-${old2}`,
      `+${new1}`,
      `+${new2}`,
      "",
    ].join("\n");
    const out = render(patch);
    expect(out).not.toMatch(/<(ins|del)>/);
    expect(lines(out)).toEqual([`-${old1}`, `-${old2}`, `+${new1}`, `+${new2}`]);
  });

  it("keeps the marks of a real edit in a line past 200 characters", () => {
    const base = "word ".repeat(50).trim();
    const patch = [
      "diff --git a/x.md b/x.md",
      "--- a/x.md",
      "+++ b/x.md",
      "@@ -1,2 +1,2 @@",
      `-${base} alpha`,
      `-${base} beta`,
      `+${base} ALPHA`,
      `+${base} BETA`,
      "",
    ].join("\n");
    const out = render(patch);
    expect(out).toContain("<del>alpha</del>");
    expect(out).toContain("<ins>BETA</ins>");
  });
});

describe("describeFiles", () => {
  const describe_ = (patch: string) =>
    describeFiles(
      html(patch, { drawFileList: false, matching: "lines", outputFormat: "line-by-line" }),
      splitDiffByFile(patch),
    );

  it("says which line has no newline at the end, on the side that lacks it", () => {
    const patch = [
      "diff --git a/x.txt b/x.txt",
      "--- a/x.txt",
      "+++ b/x.txt",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-end",
      "\\ No newline at end of file",
      "+end",
      "",
    ].join("\n");
    const rows = describe_(patch).match(/<tr>[\s\S]*?<\/tr>/g)!;
    const marked = rows.filter((r) => r.includes('class="no-eol"'));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("d2h-del");
    // Beside the text, not in it: syntax colouring reads the text as code.
    expect(marked[0]).toMatch(/<span class="d2h-code-line-ctn">end<\/span><span class="no-eol"/);
  });

  it("marks a context line, and a new side that still has no newline", () => {
    const patch = [
      "diff --git a/x.txt b/x.txt",
      "--- a/x.txt",
      "+++ b/x.txt",
      "@@ -1,2 +1,2 @@",
      "-a",
      "+A",
      " end",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const rows = describe_(patch).match(/<tr>[\s\S]*?<\/tr>/g)!;
    const marked = rows.filter((r) => r.includes('class="no-eol"'));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("d2h-cntx");
  });

  it("names a mode change and a rename instead of 'File without changes'", () => {
    const patch = [
      "diff --git a/run.sh b/run.sh",
      "old mode 100644",
      "new mode 100755",
      "diff --git a/old.txt b/new.txt",
      "similarity index 100%",
      "rename from old.txt",
      "rename to new.txt",
      "",
    ].join("\n");
    const out = describe_(patch);
    expect(out).toContain("File mode changed from 100644 to 100755");
    expect(out).toContain("File renamed without changes");
    expect(out).not.toContain("File without changes");
  });

  it("leaves the diff alone when it cannot line files up with the render", () => {
    const rendered = html("diff --git a/a b/a\nold mode 100644\nnew mode 100755\n", {
      drawFileList: false,
      outputFormat: "line-by-line",
    });
    expect(describeFiles(rendered, [])).toBe(rendered);
  });
});

