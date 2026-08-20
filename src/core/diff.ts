/**
 * Split a unified diff into per-file patches.
 * Returns entries in original order; `path` is the new path (b-side), or the
 * old path for deletions.
 */
export interface FilePatch {
  path: string;
  patch: string;
}

export function splitDiffByFile(diff: string): FilePatch[] {
  const patches: FilePatch[] = [];
  const lines = diff.split("\n");
  let current: string[] | null = null;
  let currentPath: string | null = null;

  const flush = () => {
    if (current && currentPath) {
      patches.push({ path: currentPath, patch: current.join("\n") });
    }
    current = null;
    currentPath = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      current = [line];
      // "diff --git a/foo b/foo" — prefer the b-side path; fall back to a-side.
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      currentPath = m ? m[2]! : line.slice("diff --git ".length);
    } else if (current) {
      current.push(line);
      // Deleted files: b-side is /dev/null, use the a-side path instead.
      if (line.startsWith("--- a/") && currentPath === "/dev/null") {
        currentPath = line.slice("--- a/".length);
      }
      if (line === "+++ /dev/null") {
        const minus = current.find((l) => l.startsWith("--- a/"));
        if (minus) currentPath = minus.slice("--- a/".length);
      }
    }
  }
  flush();
  return patches;
}

/** Concatenate the patches of the given files (order = diff order). */
export function patchForFiles(diff: string, files: string[]): string {
  const wanted = new Set(files);
  return splitDiffByFile(diff)
    .filter((p) => wanted.has(p.path))
    .map((p) => p.patch)
    .join("\n");
}

/**
 * New-side lines of the diff with their text, per file: added and context
 * lines inside hunks — exactly the lines a GitHub comment can attach to.
 */
export function newSideLineText(diff: string): Map<string, Map<number, string>> {
  return sideLineText(diff, "new");
}

/**
 * Old-side lines with their text, per file: removed and context lines. Nothing
 * can be posted against these — they only exist to quote a line the PR took
 * out, which is a fair thing to ask the reviewer about.
 */
export function oldSideLineText(diff: string): Map<string, Map<number, string>> {
  return sideLineText(diff, "old");
}

function sideLineText(diff: string, side: "new" | "old"): Map<string, Map<number, string>> {
  const own = side === "new" ? "+" : "-";
  const result = new Map<string, Map<number, string>>();
  for (const { path, patch } of splitDiffByFile(diff)) {
    const lines = new Map<number, string>();
    let n = 0;
    let inHunk = false;
    const patchLines = patch.split("\n");
    for (let i = 0; i < patchLines.length; i++) {
      const line = patchLines[i]!;
      const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        n = Number(side === "new" ? hunk[2] : hunk[1]);
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;
      if (line === "" && i === patchLines.length - 1) continue; // trailing split artifact
      if (line.startsWith("\\")) continue; // "\ No newline at end of file"
      if (line.startsWith(own) || line.startsWith(" ") || line === "") {
        lines.set(n, line === "" ? "" : line.slice(1));
        n++;
      }
      // The other side's lines don't exist on this one.
    }
    result.set(path, lines);
  }
  return result;
}

/**
 * Line numbers (new side of the diff) that a GitHub review comment can attach
 * to, per file: added and context lines inside hunks.
 */
export function newSideLines(diff: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  for (const [path, lines] of newSideLineText(diff)) {
    result.set(path, new Set(lines.keys()));
  }
  return result;
}

/** Paths present in the diff but not claimed by any chapter. */
export function unclaimedFiles(diff: string, chapters: { files: string[] }[]): string[] {
  const claimed = new Set(chapters.flatMap((c) => c.files));
  return splitDiffByFile(diff)
    .map((p) => p.path)
    .filter((p) => !claimed.has(p));
}
