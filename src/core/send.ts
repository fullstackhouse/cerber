import { Artifact, Calibration, Comment, Verdict } from "./artifact.js";
import type { ReplyOutcome } from "./gh.js";
import { newSideLines } from "./diff.js";
import { sendTreatment } from "./raised.js";
import { withGrade } from "./severity.js";

export type ReviewEvent = "APPROVE" | "COMMENT" | "REQUEST_CHANGES";

export function eventForRecommendation(rec: Verdict["recommendation"]): ReviewEvent {
  return { approve: "APPROVE", comment: "COMMENT", request_changes: "REQUEST_CHANGES" }[
    rec
  ] as ReviewEvent;
}

export interface InlineComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}

export interface ReviewPayload {
  event: ReviewEvent;
  body: string;
  comments: InlineComment[];
  /** Comments that could not be attached inline (no/invalid line) — folded into the body. */
  folded: Comment[];
  /**
   * Findings somebody else already raised, answered in their thread instead of
   * posted again. Posted after the review, one reply each (`postReplies`).
   */
  replies: { commentId: string; replyTo: string; body: string }[];
  /** Findings somebody else already raised and nobody decided to post: left out. */
  held: Comment[];
  /** Head commit the review was drafted against; anchors inline comments there. */
  commitId?: string;
}

function graded(c: Comment): string {
  return withGrade(c.body, c.severity);
}

/**
 * Build the GitHub review payload from an artifact.
 * Includes every comment that is not dropped, except the ones somebody else
 * already raised: those are held back or answered in that reviewer's thread,
 * as `sendTreatment` says. Comments whose line is not part of the diff (GitHub
 * would reject them) are folded into the review body.
 */
export function buildReviewPayload(artifact: Artifact, event: ReviewEvent): ReviewPayload {
  const active = artifact.comments.filter((c) => c.status !== "dropped");
  const anchorable = newSideLines(artifact.diff);

  const inline: InlineComment[] = [];
  const folded: Comment[] = [];
  const replies: ReviewPayload["replies"] = [];
  const held: Comment[] = [];
  for (const c of active) {
    const treatment = sendTreatment(c);
    if (treatment === "hold") {
      held.push(c);
      continue;
    }
    if (treatment === "reply" && c.alreadyRaised?.where.kind === "thread") {
      replies.push({ commentId: c.id, replyTo: c.alreadyRaised.where.replyTo, body: graded(c) });
      continue;
    }
    // A drifted comment's line number may still exist in the diff, but it now
    // holds different code — posting there would point the author at something
    // the comment was never about.
    if (!c.drifted && c.line != null && anchorable.get(c.path)?.has(c.line)) {
      inline.push({ path: c.path, line: c.line, side: "RIGHT", body: graded(c) });
    } else {
      folded.push(c);
    }
  }

  const parts: string[] = [];
  if (artifact.summary) {
    parts.push("## Summary", "", artifact.summary);
  }
  if (artifact.chapters.length > 0) {
    parts.push("", "## Walkthrough", "");
    for (const ch of artifact.chapters) {
      parts.push(`**${ch.title}**`, "", ch.explanation, "");
    }
  }
  if (folded.length > 0) {
    parts.push("", "## Additional notes", "");
    for (const c of folded) {
      // A drifted comment's line no longer exists, so name it as "was at" —
      // pointing a reader at a line number that moved is worse than no number.
      const at = c.line != null ? `:${c.drifted ? `~${c.line}` : c.line}` : "";
      parts.push(`- \`${c.path}${at}\` — ${graded(c)}`);
    }
  }
  parts.push("", "---", "_Reviewed with [cerber](https://github.com/fullstackhouse/cerber) 🐕 — drafted by AI, sent by a human._");

  return {
    event,
    // A body the user wrote by hand replaces the composed one outright,
    // footer and folded notes included: it is the review's own comment, and
    // half-honouring it — keeping a footer they deleted, re-appending notes
    // they cut — would post something nobody wrote. It is not trimmed either,
    // which is not fussiness: a body opening on an indented line is a markdown
    // code block, and trimming it would silently repaint it as a paragraph.
    // Only the composed body is trimmed — the parts above put a blank line in
    // front of it. The composition still runs regardless, because `folded` is
    // what the cockpit uses to say which comments have no line to land on.
    body: artifact.bodyOverride ?? parts.join("\n").trim(),
    comments: inline,
    folded,
    replies,
    held,
    commitId: artifact.pr.headSha || undefined,
  };
}

/** Snapshot of AI-proposal vs human-final, recorded at send time for `cerber stats`. */
export function computeCalibration(artifact: Artifact, event: ReviewEvent): Calibration {
  const ai = artifact.comments.filter((c) => c.origin === "ai");
  return {
    aiRecommendation: artifact.verdict?.recommendation ?? null,
    aiConfidence: artifact.verdict?.confidence ?? null,
    sentEvent: event,
    aiCommentsTotal: ai.length,
    aiCommentsDropped: ai.filter((c) => c.status === "dropped").length,
    aiCommentsEdited: ai.filter((c) => c.editedByUser).length,
    userCommentsAdded: artifact.comments.filter((c) => c.origin === "user").length,
  };
}

/**
 * Write how a Send's replies went onto the comments they answered for. A reply
 * that failed leaves `replied` null, which is what the cockpit reads to say so.
 */
export function recordReplies(artifact: Artifact, outcomes: ReplyOutcome[]): Artifact {
  const posted = new Map(outcomes.filter((o) => o.error === null).map((o) => [o.commentId, o]));
  if (posted.size === 0) return artifact;
  return {
    ...artifact,
    comments: artifact.comments.map((c) => {
      const o = posted.get(c.id);
      return o && c.alreadyRaised ? { ...c, alreadyRaised: { ...c.alreadyRaised, replied: { at: o.at, url: o.url } } } : c;
    }),
  };
}

/** "2 replies did not post: …" — or null when every one did. */
export function describeReplyFailures(outcomes: ReplyOutcome[]): string | null {
  const failed = outcomes.filter((o) => o.error !== null);
  if (failed.length === 0) return null;
  return (
    `${failed.length} ${failed.length === 1 ? "reply" : "replies"} in an existing thread did not post: ` +
    failed.map((o) => o.error).join("; ")
  );
}
