import type { AlreadyRaised, Artifact, Comment, RaisedCheck, RaisedPlace } from "./artifact.js";

/**
 * Findings somebody else already raised on the PR — the pure half.
 *
 * The review is written blind to what is already said on the PR, and compared
 * against it afterwards (`src/runner/raised.ts` does the reading and the model
 * call). This file holds the rules that need neither: what Send does with a
 * match, which of several matches a comment keeps, and how a finished check
 * folds onto an artifact that may have moved while it ran.
 *
 * No runtime imports: the cockpit imports `sendTreatment` from here so the
 * count it shows before Send is the same rule Send follows.
 */

/** Something another reviewer said on the PR, as the check reads it. */
export type PriorRemark = {
  /** GitHub node id of the thread or the review. */
  id: string;
  by: string;
  bot: boolean;
  at: string;
  body: string;
  url: string | null;
} & RaisedPlace;

/** What Send does with one comment. */
export type SendTreatment = "post" | "reply" | "hold";

/**
 * The rule Send follows for a comment, given what is known about who else
 * raised it. Dropped comments never reach this — they post nothing either way.
 *
 * Undecided is not "post": a duplicate the user never looked at is exactly what
 * this exists to keep off the PR. The one place undecided still posts is a
 * resolved thread — somebody marked that problem settled, and a review that
 * found it again in the current code is saying it isn't.
 */
export function sendTreatment(comment: {
  alreadyRaised?: Pick<AlreadyRaised, "decision" | "where"> | null;
}): SendTreatment {
  const raised = comment.alreadyRaised;
  if (!raised) return "post";
  if (raised.decision === "send") return "post";
  // Only a thread can be answered; a reply decision anywhere else is not one
  // the cockpit or the API will write, and holding is the side that posts less.
  if (raised.decision === "reply") return raised.where.kind === "thread" ? "reply" : "hold";
  return raised.where.kind === "thread" && raised.where.state === "resolved" ? "post" : "hold";
}

/**
 * Which match a comment keeps when several remarks raised the same thing:
 * the liveliest place first, because that is what decides whether posting it
 * again would repeat a conversation still going on. An open thread, then an
 * outdated one nobody resolved, then a review body, then a resolved thread.
 * Ties go to whoever said it first.
 */
function rank(place: RaisedPlace): number {
  if (place.kind === "review") return 2;
  return { open: 0, outdated: 1, resolved: 3 }[place.state];
}

export function pickMatch(candidates: AlreadyRaised[]): AlreadyRaised | null {
  if (candidates.length === 0) return null;
  return candidates.reduce((best, c) => {
    const d = rank(c.where) - rank(best.where);
    return d < 0 || (d === 0 && c.at < best.at) ? c : best;
  });
}

/** A remark as the match it becomes on a comment. */
export function raisedFrom(remark: PriorRemark, reason: string): AlreadyRaised {
  const where: RaisedPlace =
    remark.kind === "thread"
      ? { kind: "thread", path: remark.path, line: remark.line, state: remark.state, replyTo: remark.replyTo }
      : { kind: "review" };
  return {
    remarkId: remark.id,
    by: remark.by,
    at: remark.at,
    url: remark.url,
    where,
    reason,
    decision: null,
    replied: null,
    others: [],
  };
}

/** The comments a check compares: the AI's, and only those still in the draft. */
export function comparable(comments: Comment[]): Comment[] {
  // Not the user's own. A comment you wrote is something you decided to say,
  // and holding it back from Send by default would overrule you.
  return comments.filter((c) => c.origin === "ai" && c.status !== "dropped");
}

/**
 * What a check has to compare: everything new against everything, and nothing
 * already compared against each other. Empty on both sides means no model call.
 */
export function whatToCompare(
  comments: Comment[],
  remarks: PriorRemark[],
  previous: RaisedCheck | null,
): { findings: Comment[]; remarks: PriorRemark[] } {
  const findings = comparable(comments);
  const seenRemarks = new Set(previous?.remarks ?? []);
  const seenFindings = new Set(previous?.findings ?? []);
  const newRemarks = remarks.filter((r) => !seenRemarks.has(r.id));
  const newFindings = findings.filter((f) => !seenFindings.has(f.id));
  if (newRemarks.length === 0 && newFindings.length === 0) return { findings: [], remarks: [] };
  // New remarks are compared against every finding, new findings against
  // every remark. Doing both whenever either is new over-asks a little, and
  // is one call either way.
  return {
    findings: newRemarks.length > 0 ? findings : newFindings,
    remarks: newFindings.length > 0 ? remarks : newRemarks,
  };
}

/** One finding the model judged the same defect as one remark. */
export interface RaisedMatch {
  findingId: string;
  remarkId: string;
  reason: string;
}

/** What a finished check found, ready to fold onto whatever the artifact says by then. */
export interface RaisedCheckResult {
  at: string;
  /** Everything others have said on the PR, as of this check. */
  remarks: PriorRemark[];
  /** The findings that have now been compared against all of `remarks`. */
  findings: string[];
  matches: RaisedMatch[];
}

const NO_CHECK: RaisedCheck = { at: null, checkingSince: null, remarks: [], findings: [], error: null };

/** Mark a check as running, so the cockpit waits for it. */
export function startRaisedCheck(artifact: Artifact, at: string): Artifact {
  return { ...artifact, raisedCheck: { ...(artifact.raisedCheck ?? NO_CHECK), checkingSince: at } };
}

/**
 * Fold a finished check onto the artifact as it is now.
 *
 * The check takes up to a minute and reads a snapshot, so by the time it lands the
 * user may have dropped a comment, decided about a match, or a chat turn may
 * have added one. It writes `alreadyRaised` and `raisedCheck` and nothing else,
 * and a comment it has nothing new to say about keeps what it had — the user's
 * decision included, as long as it is still about the same remark.
 *
 * A remark that is gone from the PR (deleted) takes its match with it. A
 * remark still there refreshes its state, so a thread resolved since the last
 * check reads as resolved — and posts by default — without a model call.
 */
export function foldRaised(current: Artifact, result: RaisedCheckResult): Artifact {
  // A sent review is a record of what was posted; nothing is re-decided on it.
  if (current.sent) {
    return current.raisedCheck ? { ...current, raisedCheck: { ...current.raisedCheck, checkingSince: null } } : current;
  }
  const remarks = new Map(result.remarks.map((r) => [r.id, r]));
  const found = new Map<string, RaisedMatch[]>();
  for (const m of result.matches) found.set(m.findingId, [...(found.get(m.findingId) ?? []), m]);

  const comments = current.comments.map((c) => {
    const before = c.alreadyRaised;
    // Every remark this comment has ever matched that is still on the PR —
    // the one shown, the ones behind it, and whatever this check found — each
    // refreshed from the remark itself, so a thread resolved since reads as
    // resolved without asking anyone.
    const known = new Map<string, string>();
    for (const m of [
      ...(before ? [{ remarkId: before.remarkId, reason: before.reason }, ...before.others] : []),
      ...(found.get(c.id) ?? []),
    ]) {
      if (remarks.has(m.remarkId) && !known.has(m.remarkId)) known.set(m.remarkId, m.reason);
    }
    const candidates = [...known].flatMap(([id, reason]) => {
      const remark = remarks.get(id);
      return remark ? [raisedFrom(remark, reason)] : [];
    });
    const best = pickMatch(candidates);
    if (best === null) return before === null ? c : { ...c, alreadyRaised: null };
    // The user's decision belongs to the remark it was made about.
    const same = before !== null && before.remarkId === best.remarkId;
    return {
      ...c,
      alreadyRaised: {
        ...best,
        decision: same ? before.decision : null,
        replied: same ? before.replied : null,
        others: candidates.filter((x) => x !== best).map((x) => ({ remarkId: x.remarkId, reason: x.reason })),
      },
    };
  });

  return {
    ...current,
    comments,
    raisedCheck: {
      at: result.at,
      checkingSince: null,
      remarks: result.remarks.map((r) => r.id),
      findings: result.findings,
      error: null,
    },
  };
}

/** A check that could not finish: say why, and leave every match as it was. */
export function foldRaisedError(current: Artifact, at: string, error: string): Artifact {
  return {
    ...current,
    raisedCheck: { ...(current.raisedCheck ?? NO_CHECK), at, checkingSince: null, error },
  };
}

/**
 * Whether a fold changed anything worth a write. Opening a review checks every
 * time, and a write moves `updatedAt` — which the queue sorts and ages rows by
 * — so a check that found nothing new must leave the file alone.
 */
export function raisedChanged(before: Artifact, after: Artifact): boolean {
  const material = (a: Artifact) =>
    JSON.stringify([
      a.comments.map((c) => c.alreadyRaised),
      a.raisedCheck && { ...a.raisedCheck, at: null },
    ]);
  return material(before) !== material(after);
}
