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

/**
 * Lines the PR took out between two blocks. A document has no place for what
 * is gone, so without this a PR that only deletes reads as unchanged.
 */
export interface MdRemoved {
  kind: "removed";
  lines: number;
}

export type MdItem = MdBlock | MdGap | MdRemoved;

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

/**
 * A run of removed lines that nothing was added in place of — it sits just
 * before new-side line `at`. A run followed by additions is an edit, and the
 * block those additions land in already says it changed — except for the
 * blocks it has more of than the additions do, which git folds into the same
 * run when a section goes right before an edited paragraph.
 */
interface Removal {
  at: number;
  lines: number;
  /** Every removed line had text — no blank line, so no whole block went. */
  solid: boolean;
}

/** The new side of a single file's patch: added and context lines, in order. */
function newSide(patch: string, removals: Removal[] = []): Line[] {
  const out: Line[] = [];
  let removing = 0;
  let solid = true;
  let removedText: string[] = [];
  const removed = () => {
    removedText = [];
    if (removing > 0) removals.push({ at: n, lines: removing, solid });
    removing = 0;
    solid = true;
  };
  let n = 0;
  let inHunk = false;
  const lines = patch.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      removed();
      n = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    // The empty string `split` leaves behind on a patch ending in a newline —
    // not a line of the file. `src/core/diff.ts` drops it for the same reason,
    // and it is the last file of a diff that gets one: counted, it would give a
    // deleted markdown file a line to read and offer it as a document.
    if (line === "" && i === lines.length - 1) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("-")) {
      // The old side isn't part of the document, but where it was is.
      removing++;
      removedText.push(line.slice(1));
      if (line.slice(1).trim() === "") solid = false;
      continue;
    }
    if (line.startsWith("+") && removing > 0) {
      // A run followed by additions is an edit, of as many blocks as were
      // added; the blocks before those went, and are reported as gone.
      const added: string[] = [];
      for (let j = i; j < lines.length && lines[j]!.startsWith("+"); j++) added.push(lines[j]!.slice(1));
      const starts = blockStarts(removedText);
      const gone = starts.length - blockStarts(added).length;
      // Additions with no text at all (blank lines) replace nothing: the
      // whole run went.
      if (gone < starts.length) {
        removing = gone > 0 ? starts[gone]! : 0;
        solid = false;
      }
    }
    removed();
    if (line.startsWith("+") || line.startsWith(" ") || line === "") {
      out.push({ n, text: line === "" ? "" : line.slice(1), added: line.startsWith("+") });
      n++;
    }
  }
  removed();
  return out;
}

/** Where each blank-line-separated block of these lines begins. */
function blockStarts(texts: string[]): number[] {
  const starts: number[] = [];
  texts.forEach((t, i) => {
    if (t.trim() !== "" && (i === 0 || texts[i - 1]!.trim() === "")) starts.push(i);
  });
  return starts;
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
  const removals: Removal[] = [];
  const lines = newSide(patch, removals);
  const isNew = isNewFile(patch);
  const items: MdItem[] = [];
  // The new-side line each item starts at, for placing removals among them.
  const starts: number[] = [];

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
      starts.push(from);
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
      starts.push(last.n + 1);
    }
    run.push(line);
  }
  flush();

  for (const { at, lines: count, solid } of removals) {
    // Taken out of a block: that block changed. Out of its middle, whatever
    // went; off its first or last line, only lines of text — a run holding a
    // blank line took a whole block of its own, which gets its own mark.
    const touched = items.filter(
      (i) =>
        i.kind === "block" &&
        ((i.from < at && at <= i.to) || (solid && (i.from === at || i.to === at - 1))),
    );
    if (touched.length > 0) {
      for (const block of touched) if (block.kind === "block") block.changed = true;
      continue;
    }
    // Between blocks (or before a stretch the diff skips): say so there.
    let at_ = starts.findIndex((s) => s >= at);
    if (at_ < 0) at_ = items.length;
    items.splice(at_, 0, { kind: "removed", lines: count });
    starts.splice(at_, 0, at);
  }

  return { items, isNew, lines: lines.length };
}
