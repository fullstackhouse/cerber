import { Artifact, Calibration, Comment, Verdict } from "./artifact.js";
import { newSideLines } from "./diff.js";

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
  /** Head commit the review was drafted against; anchors inline comments there. */
  commitId?: string;
}

/**
 * The grade travels in the text: to a reader used to review convention, an
 * unprefixed comment says "please change this", so leaving a nit bare would
 * invert its meaning. Ungraded remarks (questions, notes) stay bare.
 */
function withGrade(c: Comment): string {
  return c.severity ? `**${c.severity}:** ${c.body}` : c.body;
}

/**
 * Build the GitHub review payload from an artifact.
 * Includes every comment that is not dropped. Comments whose line is not part
 * of the diff (GitHub would reject them) are folded into the review body.
 */
export function buildReviewPayload(artifact: Artifact, event: ReviewEvent): ReviewPayload {
  const active = artifact.comments.filter((c) => c.status !== "dropped");
  const anchorable = newSideLines(artifact.diff);

  const inline: InlineComment[] = [];
  const folded: Comment[] = [];
  for (const c of active) {
    // A drifted comment's line number may still exist in the diff, but it now
    // holds different code — posting there would point the author at something
    // the comment was never about.
    if (!c.drifted && c.line != null && anchorable.get(c.path)?.has(c.line)) {
      inline.push({ path: c.path, line: c.line, side: "RIGHT", body: withGrade(c) });
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
      parts.push(`- \`${c.path}${at}\` — ${withGrade(c)}`);
    }
  }
  parts.push("", "---", "_Reviewed with [cerber](https://github.com/fullstackhouse/cerber) 🐕 — drafted by AI, sent by a human._");

  return {
    event,
    body: parts.join("\n").trim(),
    comments: inline,
    folded,
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
