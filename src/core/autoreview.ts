/**
 * Whether the inbox poll drafts a review for a repo's PRs by itself.
 *
 * `autoReview` is the default and `autoReviewRepos` overrides it per repo, in
 * either direction: `false` keeps a busy repo to the click, `true` drafts one
 * repo while the rest wait. One map rather than an allow list and a deny list,
 * so a repo can never be on both. Shared by the daemon (which runs the drafts
 * and announces the arrivals) and the cockpit's bell, which has to agree with
 * it on when a PR is news — so it imports nothing from node.
 *
 * GitHub treats owner/repo case-insensitively, and so does this: a key written
 * `Acme/Web` still matches the PR the API reports as `acme/web`.
 */
export interface AutoReviewKnobs {
  autoReview: boolean;
  autoReviewRepos: Record<string, boolean>;
}

export function autoReviewFor(knobs: AutoReviewKnobs, owner: string, repo: string): boolean {
  const want = `${owner}/${repo}`.toLowerCase();
  for (const [key, on] of Object.entries(knobs.autoReviewRepos)) {
    if (key.toLowerCase() === want) return on;
  }
  return knobs.autoReview;
}

/** Whether any repo at all is drafted unattended — what the trust warning and
 *  the strip's `trustedRuns` are about. */
export function anyAutoReview(knobs: AutoReviewKnobs): boolean {
  return knobs.autoReview || Object.values(knobs.autoReviewRepos).some(Boolean);
}
