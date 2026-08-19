import { Comment } from "./artifact.js";
import { newSideLineText } from "./diff.js";

/**
 * Pull comments from the diff they were written against onto a newer diff.
 *
 * A comment stores a line *number*, but what the human meant is a line of
 * *code*. When the PR gets new commits those drift apart: line 218 in the
 * reviewed commit may be line 231 now, or gone entirely. GitHub rejects a
 * whole review when any inline comment names a line that is not in the diff,
 * so this decides — per comment — whether the code can still be found.
 *
 * Matching is exact and deterministic: no fuzzy edit distance, no AI. A
 * comment moves only when the evidence is unambiguous; anything else is
 * reported as drifted so a human looks at it.
 */

export type AnchorState =
  | "unchanged" // same line, same code
  | "moved" // code found at a new line number
  | "drifted" // code is gone from the diff — can't post inline
  | "unanchored"; // was never attached to a line (file-level comment)

export interface AnchorResult {
  id: string;
  state: AnchorState;
  from: number | null;
  to: number | null;
}

export interface ReanchorResult {
  comments: Comment[];
  results: AnchorResult[];
  moved: number;
  drifted: number;
}

export function reanchorComments(
  comments: Comment[],
  oldDiff: string,
  newDiff: string,
): ReanchorResult {
  const before = newSideLineText(oldDiff);
  const after = newSideLineText(newDiff);
  const results: AnchorResult[] = [];

  const next = comments.map((c) => {
    const result = reanchorOne(c, before, after);
    results.push(result);
    switch (result.state) {
      case "moved":
        return {
          ...c,
          line: result.to,
          // Keep pointing at where the human wrote it, however far it travels.
          originalLine: c.originalLine ?? result.from,
          drifted: false,
        };
      case "drifted":
        // Keep the stale line number: it is the only trace of what the comment
        // was about, and the send path folds it into the body either way.
        return { ...c, drifted: true };
      default:
        return c.drifted ? { ...c, drifted: false } : c;
    }
  });

  return {
    comments: next,
    results,
    moved: results.filter((r) => r.state === "moved").length,
    drifted: results.filter((r) => r.state === "drifted").length,
  };
}

function reanchorOne(
  comment: Comment,
  before: Map<string, Map<number, string>>,
  after: Map<string, Map<number, string>>,
): AnchorResult {
  const { id, path, line } = comment;
  if (line == null) return { id, state: "unanchored", from: null, to: null };

  const oldLines = before.get(path);
  const newLines = after.get(path);
  const oldText = oldLines?.get(line);
  // No text to match on (the comment was already off-diff), or the file is not
  // in the new diff at all — either way there is nothing to anchor to.
  if (!oldLines || !newLines || oldText === undefined) {
    return { id, state: "drifted", from: line, to: null };
  }
  if (newLines.get(line) === oldText) {
    return { id, state: "unchanged", from: line, to: line };
  }

  const candidates = [...newLines].filter(([, text]) => text === oldText).map(([n]) => n);
  if (candidates.length === 0) return { id, state: "drifted", from: line, to: null };
  if (candidates.length === 1) return { id, state: "moved", from: line, to: candidates[0]! };

  // The line alone is ambiguous ("}", a blank line, a repeated call). Ask the
  // neighbours: keep only candidates whose surrounding lines match too.
  const withContext = candidates.filter((n) => contextMatches(oldLines, line, newLines, n));
  if (withContext.length === 1) return { id, state: "moved", from: line, to: withContext[0]! };
  return { id, state: "drifted", from: line, to: null };
}

const CONTEXT = 3;

function contextMatches(
  oldLines: Map<number, string>,
  oldLine: number,
  newLines: Map<number, string>,
  newLine: number,
): boolean {
  for (let offset = -CONTEXT; offset <= CONTEXT; offset++) {
    if (offset === 0) continue;
    const oldText = oldLines.get(oldLine + offset);
    // Outside the old hunk there is nothing to compare — treat as neutral.
    if (oldText === undefined) continue;
    if (newLines.get(newLine + offset) !== oldText) return false;
  }
  return true;
}
