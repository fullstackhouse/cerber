// What a finished review is made of, as the detail view needs to state it.
//
// Where a comment ends up on GitHub is decided by src/core/send.ts at send
// time; this mirrors that rule so the cockpit can say "5 inline · 1 folded into
// the body" before anything is posted, without a round trip per keystroke.

import { newSideLines } from "../../src/core/diff";
import { Artifact, ReviewComment, Verdict } from "./types";

export type ReviewEvent = "APPROVE" | "COMMENT" | "REQUEST_CHANGES";

export const EVENT_LABEL: Record<ReviewEvent, string> = {
  APPROVE: "approve",
  COMMENT: "comment",
  REQUEST_CHANGES: "request changes",
};

export const EVENT_TONE: Record<ReviewEvent, "approve" | "comment" | "changes"> = {
  APPROVE: "approve",
  COMMENT: "comment",
  REQUEST_CHANGES: "changes",
};

/** The event a verdict asks for. The user can still choose another one. */
export function eventForVerdict(verdict: Verdict | null | undefined): ReviewEvent {
  if (verdict?.recommendation === "approve") return "APPROVE";
  if (verdict?.recommendation === "request_changes") return "REQUEST_CHANGES";
  return "COMMENT";
}

/**
 * Which of these comments can post inline against this patch: the line is still
 * in the diff and the code it pointed at hasn't drifted out from under it.
 */
export function inlineComments(patch: string, comments: ReviewComment[]): ReviewComment[] {
  const anchorable = newSideLines(patch);
  return comments.filter(
    (c) => !c.drifted && c.line != null && anchorable.get(c.path)?.has(c.line),
  );
}

/**
 * Mirrors buildReviewPayload: a comment posts inline when it can be anchored;
 * everything else that isn't dropped folds into the review body.
 */
export function splitComments(artifact: Artifact): {
  inline: ReviewComment[];
  folded: ReviewComment[];
  dropped: ReviewComment[];
} {
  const dropped = artifact.comments.filter((c) => c.status === "dropped");
  const active = artifact.comments.filter((c) => c.status !== "dropped");
  const inline = inlineComments(artifact.diff, active);
  return { inline, folded: active.filter((c) => !inline.includes(c)), dropped };
}

/** "5 inline · 1 folded into the body" — what send is about to put on the PR. */
export function payloadSummary(artifact: Artifact): string {
  const { inline, folded } = splitComments(artifact);
  if (inline.length === 0 && folded.length === 0) return "no inline comments · body only";
  const parts = [`${inline.length} inline`];
  if (folded.length > 0) {
    parts.push(`${folded.length} folded into the body`);
  }
  return parts.join(" · ");
}
