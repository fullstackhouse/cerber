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

/** Paths present in the diff but not claimed by any chapter. */
export function unclaimedFiles(diff: string, chapters: { files: string[] }[]): string[] {
  const claimed = new Set(chapters.flatMap((c) => c.files));
  return splitDiffByFile(diff)
    .map((p) => p.path)
    .filter((p) => !claimed.has(p));
}
