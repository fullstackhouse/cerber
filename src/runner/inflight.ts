/**
 * Which reviews this process is running right now.
 *
 * `cerber serve --daemon` starts reviews from a timer while the cockpit can
 * start them from a click. Both write the same artifact file, so two runs for
 * one PR would race and the loser's work would vanish. The daemon's `pool`
 * only bounds its own concurrency; this is what the two paths share.
 *
 * In-process only: a `cerber review` in another terminal is invisible here.
 * That's the pre-existing situation and the artifact write is atomic, so the
 * cost is a wasted run, not a corrupt file.
 */

const running = new Set<string>();

export class ReviewInProgressError extends Error {
  constructor(readonly id: string) {
    super(`a review of ${id} is already running`);
    this.name = "ReviewInProgressError";
  }
}

/** Claim the slot for an artifact id. Throws if it is already claimed. */
export function beginReview(id: string): void {
  if (running.has(id)) throw new ReviewInProgressError(id);
  running.add(id);
}

export function endReview(id: string): void {
  running.delete(id);
}

export function isReviewRunning(id: string): boolean {
  return running.has(id);
}
