import { describe, expect, it } from "vitest";
import {
  newSideLineText,
  oldSideLineText,
  patchForFiles,
  splitDiffByFile,
  unclaimedFiles,
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
