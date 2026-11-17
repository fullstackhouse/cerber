import { describe, expect, it } from "vitest";
import {
  diffLineCounts,
  fileFingerprint,
  newSideLineText,
  newSideLines,
  oldSideLineText,
  patchForFiles,
  plainPaths,
  splitDiffByFile,
  unclaimedFiles,
  unquoteGitPath,
} from "./diff.js";

const SAMPLE = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1;
+const b = 2;
 export { a };
diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 333..000
--- a/src/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-const gone = true;
-export { gone };
diff --git a/docs/readme.md b/docs/readme.md
index 444..555 100644
--- a/docs/readme.md
+++ b/docs/readme.md
@@ -1 +1,2 @@
 # readme
+more docs
`;

describe("splitDiffByFile", () => {
  it("splits a multi-file diff into per-file patches", () => {
    const patches = splitDiffByFile(SAMPLE);
    expect(patches.map((p) => p.path)).toEqual(["src/a.ts", "src/old.ts", "docs/readme.md"]);
    expect(patches[0]!.patch).toContain("+const b = 2;");
    expect(patches[0]!.patch).not.toContain("gone");
  });

  it("uses the old path for deleted files", () => {
    const patches = splitDiffByFile(SAMPLE);
    expect(patches[1]!.path).toBe("src/old.ts");
    expect(patches[1]!.patch).toContain("-const gone = true;");
  });

  it("returns empty array for empty diff", () => {
    expect(splitDiffByFile("")).toEqual([]);
  });
});

describe("patchForFiles", () => {
  it("concatenates only the requested files in diff order", () => {
    const patch = patchForFiles(SAMPLE, ["docs/readme.md", "src/a.ts"]);
    expect(patch).toContain("+const b = 2;");
    expect(patch).toContain("+more docs");
    expect(patch).not.toContain("gone");
    expect(patch.indexOf("src/a.ts")).toBeLessThan(patch.indexOf("docs/readme.md"));
  });

  it("returns empty string when no files match", () => {
    expect(patchForFiles(SAMPLE, ["nope.ts"])).toBe("");
  });
});

describe("unclaimedFiles", () => {
  it("finds files not covered by any chapter", () => {
    const chapters = [{ files: ["src/a.ts"] }, { files: ["src/old.ts"] }];
    expect(unclaimedFiles(SAMPLE, chapters)).toEqual(["docs/readme.md"]);
  });
});

describe("oldSideLineText", () => {
  it("maps old-side line numbers to the code that was there", () => {
    const lines = oldSideLineText(SAMPLE).get("src/a.ts")!;
    expect(lines.get(1)).toBe("const a = 1;");
    // The added line is on the new side only, so the old side never shifts.
    expect(lines.get(2)).toBe("export { a };");
    expect(lines.has(3)).toBe(false);
  });

  it("keeps the lines of a deleted file, which the new side has none of", () => {
    expect(oldSideLineText(SAMPLE).get("src/old.ts")!.get(1)).toBe("const gone = true;");
    expect(newSideLineText(SAMPLE).get("src/old.ts")!.size).toBe(0);
  });
});

describe("diffLineCounts", () => {
  it("counts each file's diff lines, which is what the cockpit has to draw", () => {
    const counts = diffLineCounts(SAMPLE);
    expect([...counts.keys()]).toEqual(splitDiffByFile(SAMPLE).map((p) => p.path));
    for (const p of splitDiffByFile(SAMPLE)) {
      expect(counts.get(p.path)).toBe(p.patch.split("\n").length);
    }
  });

  it("has nothing to count in an empty diff", () => {
    expect(diffLineCounts("").size).toBe(0);
  });
});

describe("fileFingerprint", () => {
  const patch = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1;
+const b = 2;
 export { a };`;

  it("ignores what a rebase moves: blob ids and hunk positions", () => {
    const rebased = patch.replace("index 111..222", "index 999..888").replace("@@ -1,3 +1,4 @@", "@@ -10,3 +10,4 @@");
    expect(fileFingerprint(rebased)).toBe(fileFingerprint(patch));
  });

  it("changes when the change does", () => {
    expect(fileFingerprint(patch.replace("const b = 2;", "const b = 3;"))).not.toBe(fileFingerprint(patch));
  });

  it("counts a removed `-- comment`, which reads like a file header", () => {
    const sql = (removed: string) =>
      `diff --git a/q.sql b/q.sql\n--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1,1 @@\n select 1;\n--- ${removed}`;
    expect(fileFingerprint(sql("old note"))).not.toBe(fileFingerprint(sql("other note")));
  });

  it("tells two versions of a binary apart by the only line that differs", () => {
    const binary = (index: string) =>
      `diff --git a/logo.png b/logo.png\nindex ${index} 100644\nBinary files a/logo.png and b/logo.png differ`;
    expect(fileFingerprint(binary("111..222"))).not.toBe(fileFingerprint(binary("111..333")));
  });
});

describe("quoted paths", () => {
  // As GitHub's diff (and git's) writes a file named `docs/zażółć gęślą.md`.
  const Q = String.raw`"a/docs/za\305\274\303\263\305\202\304\207 g\304\231\305\233l\304\205.md"`;
  const NAME = "docs/zażółć gęślą.md";
  const QUOTED = [
    `diff --git ${Q} ${Q.replace('"a/', '"b/')}`,
    "index 422c2b7..55dce13 100644",
    `--- ${Q}\t`,
    `+++ ${Q.replace('"a/', '"b/')}\t`,
    "@@ -1,2 +1,2 @@",
    " a",
    '-"b/quoted" in the text',
    '+"c/quoted" in the text',
    "",
  ].join("\n");

  it("reads git's octal-escaped UTF-8 back into the name", () => {
    expect(unquoteGitPath(Q)).toBe(`a/${NAME}`);
    expect(unquoteGitPath(String.raw`"a/tab\there \"q\" back\\slash"`)).toBe('a/tab\there "q" back\\slash');
    expect(unquoteGitPath("a/plain.md")).toBe("a/plain.md");
  });

  it("names the file by its real path, and writes its headers plainly", () => {
    const [file] = splitDiffByFile(QUOTED);
    expect(file!.path).toBe(NAME);
    expect(file!.patch).toContain(`diff --git a/${NAME} b/${NAME}\n`);
    expect(file!.patch).toContain(`+++ b/${NAME}\n`);
    // A hunk is the file's text, not a header, however it looks.
    expect(file!.patch).toContain('-"b/quoted" in the text');
    expect(newSideLines(QUOTED).get(NAME)).toEqual(new Set([1, 2]));
  });

  it("rewrites the headers of the whole diff and nothing else", () => {
    const plain = plainPaths(QUOTED);
    expect(plain).not.toContain("\\305");
    expect(plain).toContain('+"c/quoted" in the text');
    expect(splitDiffByFile(plain)[0]!.path).toBe(NAME);
  });

  it("finds a path containing ' b/' in a header with no ---/+++ pair", () => {
    const mode = ["diff --git a/x b/y.sh b/x b/y.sh", "old mode 100644", "new mode 100755", ""].join("\n");
    expect(splitDiffByFile(mode)[0]!.path).toBe("x b/y.sh");
  });

  it("drops the tab git ends a name holding a space with", () => {
    const spaced = ["diff --git a/my file.md b/my file.md", "--- a/my file.md\t", "+++ b/my file.md\t", "@@ -1 +1 @@", "-a", "+b", ""].join("\n");
    expect(splitDiffByFile(spaced)[0]!.path).toBe("my file.md");
  });
});

