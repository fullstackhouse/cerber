// Reading a markdown file in the diff as the document it is.
//
// A PR that adds a 1,400-line spec renders as 1,400 rows of `+ # Heading`,
// which is the one form in which nobody can review it: the reviewer's job
// there is to read a document, and the diff markers carry no information at
// all when every line is an addition. This turns a file's patch back into the
// document, in blocks that still know which source lines they came from — so a
// comment on line 188 can sit where line 188 is, and the parts the PR changed
// can be marked as changed.

import { marked } from "marked";

export interface MdBlock {
  kind: "block";
  /** The markdown of this block alone, parsed by the caller. */
  raw: string;
  /** New-side line numbers this block spans, inclusive. */
  from: number;
  to: number;
  /** The PR adds at least one of these lines. */
  changed: boolean;
}

/** Lines between two hunks — present in the file, absent from the diff. */
export interface MdGap {
  kind: "gap";
  lines: number;
}

export type MdItem = MdBlock | MdGap;

export interface MdDocument {
  items: MdItem[];
  /** The PR creates this file, so the diff is the whole document. */
  isNew: boolean;
  /** New-side lines the diff carries — 0 means there is nothing to read. */
  lines: number;
}

const MARKDOWN = /\.(md|markdown)$/i;

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN.test(path);
}

/** Does this patch create the file? Then every line of it is in the diff. */
export function isNewFile(patch: string): boolean {
  return /^new file mode /m.test(patch) || /^--- \/dev\/null$/m.test(patch);
}

interface Line {
  n: number;
  text: string;
  added: boolean;
}

/** The new side of a single file's patch: added and context lines, in order. */
function newSide(patch: string): Line[] {
  const out: Line[] = [];
  let n = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      n = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("-")) continue; // the old side isn't part of the document
    if (line.startsWith("+") || line.startsWith(" ") || line === "") {
      out.push({ n, text: line === "" ? "" : line.slice(1), added: line.startsWith("+") });
      n++;
    }
  }
  return out;
}

const newlines = (s: string) => (s.match(/\n/g) ?? []).length;

/**
 * The document a patch's new side reads as, block by block.
 *
 * Blocks are markdown's own top-level units (a paragraph, a heading, a fenced
 * block, a whole list), because those are the units a reader points at — and
 * because a block is the smallest thing that can be parsed on its own without
 * changing what it means.
 */
export function readMarkdown(patch: string): MdDocument {
  const lines = newSide(patch);
  const isNew = isNewFile(patch);
  const items: MdItem[] = [];

  // Consecutive lines form a run; the holes between runs are the parts of the
  // file the diff never showed us, and saying so is the honest thing to draw.
  let run: Line[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const start = run[0]!.n;
    const added = new Set(run.filter((l) => l.added).map((l) => l.n));
    const text = run.map((l) => l.text).join("\n") + "\n";
    // A token's `raw` picks up where the last one left off — concatenated they
    // are the source again — so counting newlines through them walks the file
    // exactly, whether or not a token happens to carry its own terminator.
    let line = start;
    for (const token of marked.lexer(text)) {
      const raw = token.raw;
      const body = raw.trimEnd();
      if (body === "") {
        line += newlines(raw);
        continue;
      }
      const lead = raw.length - raw.trimStart().length;
      const from = line + newlines(raw.slice(0, lead));
      const to = from + newlines(body.slice(lead));
      let changed = false;
      for (let n = from; n <= to && !changed; n++) changed = added.has(n);
      items.push({ kind: "block", raw: body.slice(lead), from, to, changed });
      line += newlines(raw);
    }
    run = [];
  };

  for (const line of lines) {
    const last = run[run.length - 1];
    if (last && line.n !== last.n + 1) {
      const gap = line.n - last.n - 1;
      flush();
      items.push({ kind: "gap", lines: gap });
    }
    run.push(line);
  }
  flush();

  return { items, isNew, lines: lines.length };
}
