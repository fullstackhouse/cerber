import { describe, expect, it } from "vitest";
import { isMarkdownPath, isNewFile, readMarkdown } from "./mdblocks";

/** A patch that adds a whole file, the way `gh pr diff` spells one. */
const added = (path: string, body: string) => {
  const lines = body.split("\n");
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
  ].join("\n");
};

describe("isMarkdownPath", () => {
  it("takes .md and .markdown, and nothing else", () => {
    expect(isMarkdownPath("docs/a.md")).toBe(true);
    expect(isMarkdownPath("README.MARKDOWN")).toBe(true);
    expect(isMarkdownPath("src/a.ts")).toBe(false);
    expect(isMarkdownPath("a.mdx")).toBe(false);
  });
});

describe("isNewFile", () => {
  it("reads the file as created", () => {
    expect(isNewFile(added("a.md", "# hi"))).toBe(true);
  });

  it("does not claim a modification is one", () => {
    expect(isNewFile("diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1 +1 @@\n-a\n+b")).toBe(
      false,
    );
  });
});

describe("readMarkdown of an added file", () => {
  const doc = readMarkdown(added("spec.md", "# Title\n\nA paragraph.\n\n- one\n- two\n"));

  it("is the whole document", () => {
    expect(doc.isNew).toBe(true);
    expect(doc.items.filter((i) => i.kind === "gap")).toHaveLength(0);
  });

  it("splits into markdown's own top-level blocks", () => {
    const blocks = doc.items.flatMap((i) => (i.kind === "block" ? [i] : []));
    expect(blocks.map((b) => b.raw.trim())).toEqual(["# Title", "A paragraph.", "- one\n- two"]);
  });

  it("numbers each block with the lines it came from", () => {
    const blocks = doc.items.flatMap((i) => (i.kind === "block" ? [i] : []));
    expect(blocks.map((b) => [b.from, b.to])).toEqual([
      [1, 1],
      [3, 3],
      [5, 6],
    ]);
  });

  it("keeps a fenced block whole, markers and all", () => {
    const fenced = readMarkdown(added("a.md", "before\n\n```ts\nconst a = 1;\n```\n\nafter"));
    const blocks = fenced.items.flatMap((i) => (i.kind === "block" ? [i] : []));
    expect(blocks[1]!.raw.trim()).toBe("```ts\nconst a = 1;\n```");
    expect(blocks[1]!.from).toBe(3);
    expect(blocks[1]!.to).toBe(5);
  });
});

describe("readMarkdown of a modified file", () => {
  const patch = [
    "diff --git a/spec.md b/spec.md",
    "--- a/spec.md",
    "+++ b/spec.md",
    "@@ -1,3 +1,4 @@",
    " # Title",
    " ",
    "+A new paragraph.",
    " Old text.",
    "@@ -40,2 +41,2 @@",
    "-was this",
    "+is now this",
    " trailing",
  ].join("\n");
  const doc = readMarkdown(patch);

  it("marks only the blocks the PR touches", () => {
    const blocks = doc.items.flatMap((i) => (i.kind === "block" ? [i] : []));
    expect(blocks.map((b) => [b.raw.trim(), b.changed])).toEqual([
      ["# Title", false],
      ["A new paragraph.\nOld text.", true],
      ["is now this\ntrailing", true],
    ]);
  });

  it("says where the diff skipped part of the file", () => {
    expect(doc.items.filter((i) => i.kind === "gap")).toEqual([{ kind: "gap", lines: 36 }]);
  });

  it("leaves out the lines the PR removes — they are not in the document", () => {
    expect(doc.items.some((i) => i.kind === "block" && i.raw.includes("was this"))).toBe(false);
  });
});

describe("readMarkdown of a deleted file", () => {
  const patch = [
    "diff --git a/gone.md b/gone.md",
    "deleted file mode 100644",
    "--- a/gone.md",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-# Title",
    "-body",
  ].join("\n");

  it("has nothing to read", () => {
    expect(readMarkdown(patch).lines).toBe(0);
  });

  // `splitDiffByFile` hands the last file of a diff a patch ending in a
  // newline, so `split` leaves an empty string behind. Counted as a line, it
  // would give this file something to read and offer it as a document.
  it("still has nothing to read when its patch ends in a newline", () => {
    expect(readMarkdown(`${patch}\n`).lines).toBe(0);
  });
});

describe("the empty string at the end of a patch", () => {
  it("is not a line of the file", () => {
    const doc = readMarkdown(`${added("a.md", "# Hi")}\n`);
    expect(doc.lines).toBe(1);
    expect(doc.items).toEqual([{ kind: "block", raw: "# Hi", from: 1, to: 1, changed: true }]);
  });
});
