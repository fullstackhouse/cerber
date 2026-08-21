// What a finished review is made of, as the detail view needs to state it.
//
// Where a comment ends up on GitHub is decided by src/core/send.ts at send
// time; this mirrors that rule so the cockpit can say "5 inline · 1 folded into
// the body" before anything is posted, without a round trip per keystroke.

import { newSideLines } from "../../src/core/diff";
import { SEVERITY_BADGE } from "../../src/core/severity";
import { Artifact, ReviewComment, Severity, Verdict } from "./types";

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
 * Which line of a file a diff row is, read off its two gutter numbers.
 *
 * A row carries the new-side number when the line survives the PR, and only an
 * old-side one when the PR removes it. Both can be talked about; only the first
 * can carry a comment GitHub will post inline, which is what `side` is for.
 * Hunk headers and spacers have neither and can't be pointed at.
 */
export function rowLine(
  num1: string | null | undefined,
  num2: string | null | undefined,
): { line: number; side: "new" | "old" } | null {
  const parse = (v: string | null | undefined) => {
    const n = Number((v ?? "").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const next = parse(num2);
  if (next != null) return { line: next, side: "new" };
  const prev = parse(num1);
  return prev != null ? { line: prev, side: "old" } : null;
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

/** "🚨 1 blocker · 🎨 2 nits" — live findings only; "" when nothing is graded. */
export function severitySummary(artifact: Artifact): string {
  const live = artifact.comments.filter((c) => c.status !== "dropped");
  const tiers: Severity[] = ["blocker", "minor", "nit"];
  const parts = tiers
    .map((tier) => ({ tier, n: live.filter((c) => c.severity === tier).length }))
    .filter(({ n }) => n > 0)
    .map(({ tier, n }) => `${SEVERITY_BADGE[tier]} ${n} ${tier}${n === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/**
 * What the verdict rests on — "no blockers", "2 blockers" — or null for a
 * review that graded nothing. Only blockers block, so the blocker count is the
 * one fact behind an approve or a request-changes. It stands where a
 * self-reported confidence percentage used to: that number said how sure the
 * AI felt, which is not something a reader can check, while this is.
 */
export function verdictBasis(artifact: Artifact): string | null {
  const graded = artifact.comments.some((c) => c.severity != null);
  if (!graded) return null;
  const n = artifact.comments.filter(
    (c) => c.status !== "dropped" && c.severity === "blocker",
  ).length;
  return n === 0 ? "no blockers" : `${n} blocker${n === 1 ? "" : "s"}`;
}

/**
 * The verdict no longer follows from the findings, in one plain sentence —
 * or null while they agree. Only blockers block, so the two ways to disagree
 * are an approve past a live blocker and a request-changes with none left.
 * A review that never graded anything (drafted before severities existed)
 * makes no claim, so it can't disagree.
 */
export function verdictMismatch(artifact: Artifact): string | null {
  if (!artifact.verdict) return null;
  const graded = artifact.comments.some((c) => c.severity != null);
  if (!graded) return null;
  const blockers = artifact.comments.filter(
    (c) => c.status !== "dropped" && c.severity === "blocker",
  ).length;
  const rec = artifact.verdict.recommendation;
  if (rec === "approve" && blockers > 0) {
    return `the verdict says approve, but ${blockers} blocker${blockers === 1 ? "" : "s"} still stand${blockers === 1 ? "s" : ""}`;
  }
  if (rec === "request_changes" && blockers === 0) {
    return "the verdict says request changes, but no blocker still stands";
  }
  return null;
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
