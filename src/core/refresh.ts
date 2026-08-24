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
 * Comments a human put work into: their own, and AI ones they rewrote.
 * A re-review regenerates everything the AI said, but must not silently bin
 * these — see `mergeRunResult` and the seeding step in `reviewPr`.
 */
export function humanComments(artifact: Artifact): Artifact["comments"] {
  return artifact.comments.filter((c) => c.origin === "user" || c.editedByUser);
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
 * A run takes minutes and the cockpit stays live throughout: the user can add,
 * edit or delete a comment, mark the review, or send it while waiting. Saving
 * the run's result wholesale silently undid all of that — the same mistake
 * `mergeConcurrentEdits` exists to stop a chat turn making.
 *
 * `fresh` is what the run produced; `current` is what is on disk now. The run
 * owns everything it regenerated — summary, chapters, verdict, AI comments —
 * and the user owns the rest:
 *
 *   - **their comments** come from `current`, not from the artifact the run
 *     read at the start, so a mid-run edit survives and a mid-run delete stays
 *     deleted. They need no re-anchoring: the run re-anchored them onto its own
 *     diff before it began (see `reviewPr`), which is the diff the cockpit was
 *     showing while they were written.
 *   - **a send** stands, and takes the status with it. Without this a run
 *     finishing after a send wrote `sent: null` back over the record, and the
 *     "already sent" guard would then wave a second submission through.
 *   - **a settle** stands too: `reviewed` and `skipped` are decisions about the
 *     PR, not facts about the code, so a run completing does not reopen one.
 *     The draft still lands underneath, which is what the row shows if the
 *     user changes their mind.
 */
export function mergeRunResult(fresh: Artifact, current: Artifact): Artifact {
  return {
    ...fresh,
    comments: [...fresh.comments, ...humanComments(current)],
    status: userOwnsStatus(current) ? current.status : fresh.status,
    sent: current.sent,
    calibration: current.calibration,
    filed: current.filed,
    // The conversation and its snapshot belong to the user either way.
    chat: current.chat,
    preChat: current.preChat,
    pendingChat: current.pendingChat,
  };
}
