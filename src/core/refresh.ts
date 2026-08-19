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
 * these — see carryOverComments.
 */
export function humanComments(artifact: Artifact): Artifact["comments"] {
  return artifact.comments.filter((c) => c.origin === "user" || c.editedByUser);
}

/**
 * Carry a previous review's human comments into a fresh one, re-anchored to
 * the new diff. AI comments are dropped: the new run just regenerated them.
 */
export function carryOverComments(
  previous: Artifact,
  fresh: Artifact,
): { comments: Artifact["comments"]; carried: number; drifted: number } {
  const human = humanComments(previous);
  if (human.length === 0) return { comments: fresh.comments, carried: 0, drifted: 0 };

  const { comments, drifted } = reanchorComments(human, previous.diff, fresh.diff);
  return { comments: [...fresh.comments, ...comments], carried: comments.length, drifted };
}
