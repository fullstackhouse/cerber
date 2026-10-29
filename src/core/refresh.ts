import { Artifact, Comment, PrInfo, SentInfo } from "./artifact.js";
import { AnchorResult, reanchorComments } from "./anchor.js";

export interface RefreshResult {
  artifact: Artifact;
  /** False when the head SHA already matched — nothing was touched. */
  changed: boolean;
  moved: number;
  drifted: number;
  results: AnchorResult[];
}

/**
 * Pull a review forward onto the PR's current head: swap in the new diff and
 * carry every comment across, re-anchored to the code it was written about.
 *
 * The AI's summary, chapters and verdict still describe the commit that was
 * reviewed — this only keeps the comments postable. Re-reviewing is the
 * (expensive) way to get the AI's opinion of the new code.
 */
export function refreshArtifact(artifact: Artifact, pr: PrInfo, diff: string): RefreshResult {
  if (artifact.pr.headSha !== "" && artifact.pr.headSha === pr.headSha) {
    return { artifact, changed: false, moved: 0, drifted: 0, results: [] };
  }

  const { comments, results, moved, drifted } = reanchorComments(artifact.comments, artifact.diff, diff);
  return {
    artifact: {
      ...artifact,
      pr,
      diff,
      comments,
      updatedAt: new Date().toISOString(),
      refresh: {
        at: new Date().toISOString(),
        fromSha: artifact.pr.headSha,
        toSha: pr.headSha,
        moved,
        drifted,
      },
    },
    changed: true,
    moved,
    drifted,
    results,
  };
}


/**
 * A comment that is the user's call rather than the run's: one they wrote, one
 * they rewrote, or one they had the chat add or rewrite.
 */
export function isYours(c: Comment): boolean {
  return c.origin === "user" || c.editedByUser || c.fromChat;
}

/**
 * The user's comments, pulled from the diff they were written on onto the one a
 * re-review is reading.
 *
 * A re-review replaces the AI's findings, not the user's. A push from the
 * author is no reason to lose a comment they wrote or a finding they argued
 * into shape in the chat — and the old conversation would go on naming it
 * as though it were still there. Anchored by line text like a refresh; one
 * whose code is gone is marked drifted and posts in the body.
 */
export function carryYours(comments: Comment[], fromDiff: string, toDiff: string): Comment[] {
  return reanchorComments(comments.filter(isYours), fromDiff, toDiff).comments;
}

/**
 * Is this artifact's status the user's to keep, rather than the run's to set?
 *
 * A send or a settle is a decision about the PR; a run finishing is a fact
 * about the code. Whichever way the run went — a draft or an error — it does
 * not get to reopen one, which is the same rule `SETTLED_BY_YOU` applies to
 * starting a run in the first place.
 */
export function userOwnsStatus(a: Artifact): boolean {
  return a.sent !== null || a.status === "reviewed" || a.status === "skipped";
}

/**
 * This row's sends, with the one a starting run is about to supersede folded in.
 *
 * The only way back into a review that was sent is a new draft, and `sent`
 * describes a draft that is about to stop existing — so it cannot stay where
 * it is. It also cannot simply go: that review is on the PR under the user's
 * name, and a cockpit that forgets it would offer a second one as if it were
 * the first. Called by the claim at the top of a run, which is the one moment
 * a send stops covering what is on the page.
 */
export function supersede(a: Artifact): SentInfo[] {
  return a.sent ? [...a.priorSends, a.sent] : a.priorSends;
}

/**
 * Fold a finished review run onto whatever the artifact says now.
 *
 * A run takes minutes and the cockpit stays live throughout, so by the time one
 * lands the artifact may have moved under it. Saving the result wholesale
 * silently undid whatever had happened in between — the same mistake
 * `mergeConcurrentEdits` exists to stop a chat turn making.
 *
 * `fresh` is what the run produced; `current` is what is on disk now. The run
 * owns the draft — summary, chapters, verdict, the AI's comments. What it does
 * *not* own are the decisions:
 *
 *   - **a send** stands, and takes the status with it. Without this a run
 *     finishing after a send wrote `sent: null` back over the record, and the
 *     "already sent" guard would then wave a second submission through.
 *   - **a settle** stands too: `reviewed` and `skipped` are decisions about the
 *     PR, not facts about the code, so a run completing does not reopen one.
 *     The fresh draft still lands underneath, which is what the row shows if
 *     the user changes their mind.
 *   - **the conversation** is the user's writing, snapshot and all.
 *   - **the user's comments** (`carryYours`), read from disk so one written
 *     while the run worked is kept too, and put ahead of the run's own.
 */
export function mergeRunResult(fresh: Artifact, current: Artifact): Artifact {
  return {
    ...fresh,
    comments: [...carryYours(current.comments, current.diff, fresh.diff), ...fresh.comments],
    status: userOwnsStatus(current) ? current.status : fresh.status,
    // Travels with the status it dates. A settle that landed while the run
    // worked keeps both halves of itself, and a run that reopens the row takes
    // the stamp away with the status.
    settledAt: userOwnsStatus(current) ? current.settledAt : fresh.settledAt,
    sent: current.sent,
    // Written by this run's own claim (`supersede`), or by an earlier one —
    // either way the disk is the only copy; `fresh` was built before the claim.
    priorSends: current.priorSends,
    // Disk wins: the ledger is the poll's, and the run knows nothing about it.
    notified: current.notified,
    calibration: current.calibration,
    filed: current.filed,
    // Reading progress is the user's; a mark on a file the run saw change
    // unticks itself through its fingerprint.
    viewed: current.viewed,
    // A decision of the user's, like the status above it: a handoff that landed
    // while the run worked has already moved the request on GitHub, and a run
    // that wrote `null` over it would leave the row reading "skipped" with
    // nothing anywhere saying who has the PR now.
    handoff: current.handoff,
    chat: current.chat,
    preChat: current.preChat,
    pendingChat: current.pendingChat,
  };
}
