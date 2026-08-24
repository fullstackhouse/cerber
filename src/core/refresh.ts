import { Artifact, PrInfo } from "./artifact.js";
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
 * Fold a finished review run onto whatever the artifact says now.
 *
 * A run takes minutes and the cockpit stays live throughout, so by the time one
 * lands the artifact may have moved under it. Saving the result wholesale
 * silently undid whatever had happened in between — the same mistake
 * `mergeConcurrentEdits` exists to stop a chat turn making.
 *
 * `fresh` is what the run produced; `current` is what is on disk now. The run
 * owns the draft — summary, chapters, verdict, comments — and that includes
 * replacing comments the user wrote: a re-review starts fresh by design, and
 * `docs/lifecycle.md` says so plainly rather than leaving anyone to count on
 * work surviving one. What it does *not* own are the decisions:
 *
 *   - **a send** stands, and takes the status with it. Without this a run
 *     finishing after a send wrote `sent: null` back over the record, and the
 *     "already sent" guard would then wave a second submission through.
 *   - **a settle** stands too: `reviewed` and `skipped` are decisions about the
 *     PR, not facts about the code, so a run completing does not reopen one.
 *     The fresh draft still lands underneath, which is what the row shows if
 *     the user changes their mind.
 *   - **the conversation** is the user's writing, snapshot and all.
 */
export function mergeRunResult(fresh: Artifact, current: Artifact): Artifact {
  return {
    ...fresh,
    status: userOwnsStatus(current) ? current.status : fresh.status,
    sent: current.sent,
    calibration: current.calibration,
    filed: current.filed,
    chat: current.chat,
    preChat: current.preChat,
    pendingChat: current.pendingChat,
  };
}
