import { randomUUID } from "node:crypto";
import { Artifact, Refusal, Revision, ReviewSnapshot } from "./artifact.js";

/**
 * Applying a chat turn's edits to the review it is about.
 *
 * A chat turn writes the draft directly — the user asked for the change, and
 * asking again with an "accept" button would be friction wearing safety's coat.
 * What it must NOT do is quietly overwrite the user's own words: a comment the
 * user wrote or rewrote is the one thing in the artifact the AI did not author,
 * and `carryOverComments` already exists so a re-review never discards it. A
 * chat turn is the second way to lose that work, and this is where it doesn't.
 *
 * Pure: no I/O, no clock beyond what the caller passes in.
 */

export interface ReviseResult {
  artifact: Artifact;
  /** Revisions that landed. */
  applied: Revision[];
  /** Revisions the artifact would not accept, each with a plain reason. */
  refused: Refusal[];
}

/** The review as it stands, for restoring later. */
export function snapshotReview(artifact: Artifact, at: string): ReviewSnapshot {
  return {
    at,
    summary: artifact.summary,
    chapters: artifact.chapters,
    comments: artifact.comments,
    verdict: artifact.verdict,
  };
}

/** Put a review back the way the snapshot found it. Chat history is untouched. */
export function restoreReview(artifact: Artifact, snapshot: ReviewSnapshot): Artifact {
  return {
    ...artifact,
    summary: snapshot.summary,
    chapters: snapshot.chapters,
    comments: snapshot.comments,
    verdict: snapshot.verdict,
  };
}

/**
 * Fold a finished chat turn back onto whatever the artifact says now.
 *
 * A turn takes minutes, and the cockpit stays live throughout: the user can
 * edit, drop or add a comment while waiting for the answer. Writing the turn's
 * result wholesale would silently undo that, which is the one thing a run must
 * never do to the user's own work.
 *
 * `before` is the artifact the turn started from, `after` is what it produced,
 * `current` is what is on disk now. Anything the user changed between `before`
 * and `current` wins; everything else comes from the turn.
 */
export function mergeConcurrentEdits(
  before: Artifact,
  after: Artifact,
  current: Artifact,
): Artifact {
  const wasThere = new Map(before.comments.map((c) => [c.id, c]));
  const fromTurn = new Map(after.comments.map((c) => [c.id, c]));
  const userTouched = (id: string, now: (typeof current.comments)[number]) => {
    const then = wasThere.get(id);
    // Absent from `before` means the user added it while the turn ran.
    if (!then) return true;
    return then.body !== now.body || then.status !== now.status || then.severity !== now.severity;
  };

  const merged = current.comments.map((now) =>
    userTouched(now.id, now) ? now : fromTurn.get(now.id) ?? now,
  );
  // Comments the turn itself added are not in `current` yet. Only those: a
  // comment present in both `before` and `after` but missing from `current` is
  // one the user deleted while the turn ran, and pushing it back would undo
  // the deletion — the very thing this function exists to prevent. (Delete
  // removes the row outright; drop only marks it, so drops survive above.)
  const seen = new Set(merged.map((c) => c.id));
  for (const c of after.comments) {
    if (!wasThere.has(c.id) && !seen.has(c.id)) merged.push(c);
  }

  return {
    ...after,
    comments: merged,
    // The turn never sets a queue status, so a "mark reviewed" clicked while it
    // ran is the user's and stands. The verdict it can change, so the turn wins
    // there only when it actually revised one.
    status: current.status,
    verdict: after.verdict === before.verdict ? current.verdict : after.verdict,
  };
}

export interface ReviseOptions {
  /** Id generator, so tests get stable ids. Defaults to randomUUID. */
  newId?: () => string;
  /**
   * Let the run rewrite comments the user wrote or edited. Off by default and
   * only ever set when the user said so in the conversation.
   */
  allowUserComments?: boolean;
}

export function applyRevisions(
  artifact: Artifact,
  revisions: Revision[],
  opts: ReviseOptions = {},
): ReviseResult {
  const newId = opts.newId ?? randomUUID;
  const applied: Revision[] = [];
  const refused: Refusal[] = [];
  let next = artifact;

  const refuse = (revision: Revision, reason: string) => refused.push({ revision, reason });

  /** A comment the user authored or rewrote is theirs, not the run's to redo. */
  const isUsers = (id: string) => {
    const c = next.comments.find((x) => x.id === id);
    return c ? c.origin === "user" || c.editedByUser : false;
  };

  for (const revision of revisions) {
    switch (revision.kind) {
      case "summary": {
        next = { ...next, summary: revision.body };
        applied.push(revision);
        break;
      }
      case "verdict": {
        next = { ...next, verdict: revision.verdict };
        applied.push(revision);
        break;
      }
      case "chapter": {
        const chapter = next.chapters.find((ch) => ch.id === revision.chapterId);
        if (!chapter) {
          refuse(revision, `no chapter "${revision.chapterId}" in this review`);
          break;
        }
        next = {
          ...next,
          chapters: next.chapters.map((ch) =>
            ch.id === revision.chapterId
              ? {
                  ...ch,
                  title: revision.title ?? ch.title,
                  explanation: revision.explanation ?? ch.explanation,
                }
              : ch,
          ),
        };
        applied.push(revision);
        break;
      }
      case "comment-edit": {
        if (!next.comments.some((c) => c.id === revision.commentId)) {
          refuse(revision, `no comment ${revision.commentId} in this review`);
          break;
        }
        if (isUsers(revision.commentId) && !opts.allowUserComments) {
          refuse(revision, "that comment is the user's own writing — ask before rewriting it");
          break;
        }
        next = {
          ...next,
          comments: next.comments.map((c) =>
            c.id === revision.commentId
              ? {
                  ...c,
                  body: revision.body,
                  // Omitted = the turn is not re-grading; null = "not a finding".
                  severity: revision.severity === undefined ? c.severity : revision.severity,
                }
              : c,
          ),
        };
        applied.push(revision);
        break;
      }
      case "comment-drop": {
        if (!next.comments.some((c) => c.id === revision.commentId)) {
          refuse(revision, `no comment ${revision.commentId} in this review`);
          break;
        }
        if (isUsers(revision.commentId) && !opts.allowUserComments) {
          refuse(revision, "that comment is the user's own writing — ask before dropping it");
          break;
        }
        // Dropped, not deleted: `status` is what Send already reads, and the
        // cockpit shows a dropped comment struck through rather than vanished.
        next = {
          ...next,
          comments: next.comments.map((c) =>
            c.id === revision.commentId ? { ...c, status: "dropped" as const } : c,
          ),
        };
        applied.push(revision);
        break;
      }
      case "comment-add": {
        next = {
          ...next,
          comments: [
            ...next.comments,
            {
              id: newId(),
              path: revision.path,
              line: revision.line,
              body: revision.body,
              chapterId: revision.chapterId,
              severity: revision.severity,
              origin: "ai" as const,
              status: "draft" as const,
              editedByUser: false,
              originalLine: null,
              drifted: false,
            },
          ],
        };
        applied.push(revision);
        break;
      }
    }
  }

  return { artifact: next, applied, refused };
}
