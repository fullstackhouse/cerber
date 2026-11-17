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
  let current: string[] | null = null;
  let inHeader = false;

  const flush = () => {
    if (current) {
      const path = pathOf(current);
      if (path) patches.push({ path, patch: current.join("\n") });
    }
    current = null;
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      current = [unquoteHeader(line)];
      inHeader = true;
    } else if (current) {
      if (line.startsWith("@@")) inHeader = false;
      // Only the header names files; inside a hunk a `--- a/x` is a removed
      // `-- a/x`, and it stays exactly as written.
      current.push(inHeader ? unquoteHeader(line) : line);
    }
  }
  flush();
  return patches;
}

/**
 * A file's path, read off its (already unquoted) header: the new side from
 * `+++ b/…`, the old side when the file is deleted. A header without the pair
 * — a binary, a pure rename, a mode change — names it in `rename to`, or in the
 * `diff --git a/P b/P` line, which is split down the middle rather than at the
 * first ` b/`, because a path can contain one.
 */
function pathOf(lines: string[]): string | null {
  const firstHunk = lines.findIndex((l) => l.startsWith("@@"));
  const header = firstHunk < 0 ? lines : lines.slice(0, firstHunk);
  const field = (prefix: string) => header.find((l) => l.startsWith(prefix))?.slice(prefix.length);
  const plus = field("+++ ");
  if (plus?.startsWith("b/")) return plus.slice(2);
  if (plus === "/dev/null") {
    const minus = field("--- a/");
    if (minus) return minus;
  }
  const renamed = field("rename to ") ?? field("copy to ");
  if (renamed) return renamed;
  const both = lines[0]!.slice("diff --git ".length);
  const half = (both.length - 1) / 2;
  if (Number.isInteger(half)) {
    const [a, b] = [both.slice(0, half), both.slice(half + 1)];
    if (a.startsWith("a/") && b.startsWith("b/") && a.slice(2) === b.slice(2)) return b.slice(2);
  }
  const m = both.match(/^a\/(.+?) b\/(.+)$/);
  return m ? m[2]! : both || null;
}

/**
 * The diff with every file header naming its files plainly — what the review
 * run reads, so the path it writes on a comment is the one the rest of cerber
 * (and GitHub's comment API) knows the file by. Hunks are left as written.
 */
export function plainPaths(diff: string): string {
  let inHeader = false;
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("diff --git ")) inHeader = true;
      else if (line.startsWith("@@")) inHeader = false;
      return inHeader ? unquoteHeader(line) : line;
    })
    .join("\n");
}

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/**
 * A path as git writes it into a header: wrapped in quotes, with C escapes and
 * every byte outside ASCII spelled in octal, whenever it holds one — so a file
 * named `zażółć.md` arrives as `"a/za\305\274\303\263\305\202\304\207.md"`.
 * GitHub's diffs do the same.
 */
export function unquoteGitPath(quoted: string): string {
  if (!(quoted.length >= 2 && quoted.startsWith('"') && quoted.endsWith('"'))) return quoted;
  const bytes: number[] = [];
  const body = quoted.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      bytes.push(...new TextEncoder().encode(ch));
      continue;
    }
    const next = body[i + 1] ?? "";
    const octal = body.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 3;
    } else if (next in C_ESCAPES) {
      bytes.push(C_ESCAPES[next]!);
      i += 1;
    } else {
      bytes.push(92);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * A header line with every quoted path written out plainly, so the rest of the
 * cockpit — and diff2html, which prints the quotes and octal as they are —
 * sees the file's real name. The tab git ends a `---`/`+++` line with goes
 * too, or it becomes part of the name.
 */
function unquoteHeader(line: string): string {
  // git also ends a name holding a space with a tab, quoted or not.
  const bare = /^(---|\+\+\+) /.test(line) ? line.replace(/\t$/, "") : line;
  return bare.includes('"') ? bare.replace(/"(?:[^"\\]|\\.)*"/g, (q) => unquoteGitPath(q)) : bare;
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

/**
 * How many diff lines each file contributes, by path. The cockpit renders one
 * table row per line, so this is what a chapter costs a browser to draw.
 */
export function diffLineCounts(diff: string): Map<string, number> {
  return new Map(splitDiffByFile(diff).map((p) => [p.path, p.patch.split("\n").length]));
}

/**
 * What a file's change says, reduced to a short hash — the thing a "viewed"
 * mark remembers, so a new push that changes the file unticks it.
 *
 * Only the changed and context lines count: a rebase that moves the hunk
 * headers or the blob ids changes nothing you read. A patch with no such lines
 * (a binary, a pure rename) falls back to the whole patch, whose `index` line
 * is then the only thing that tells two versions apart.
 */
export function fileFingerprint(patch: string): string {
  const lines = patch.split("\n");
  // `---`/`+++` are file headers only before the first hunk; inside one they
  // are a removed `-- comment` or an added `++ line`, and those are changes.
  const firstHunk = lines.findIndex((l) => l.startsWith("@@"));
  const content = firstHunk < 0 ? [] : lines.slice(firstHunk).filter((l) => /^[+\- ]/.test(l));
  const text = (content.length > 0 ? content : lines).join("\n");
  // FNV-1a, 32-bit.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
