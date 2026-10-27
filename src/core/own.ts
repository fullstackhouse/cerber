// Your own PRs — the one test for "is this PR yours", kept free of imports so
// the cockpit's bundle can share it with the server without pulling in `gh`.

/**
 * Whether this PR is one you opened yourself.
 *
 * The one test for it, used by everything that treats your own PRs
 * differently: the poll never drafts or announces one, auto-send never fires on
 * one, Send refuses an approve or a change request on one (GitHub refuses both
 * from the author anyway), and the cockpit lists them apart from the PRs
 * somebody is waiting on you for. Derived from the PR's author rather than
 * stored, so there is no field to drift out of step with GitHub.
 *
 * A login nobody could fetch claims nothing (false), and so does an author the
 * row never recorded. GitHub logins are case-insensitive.
 */
export function isOwnPr(pr: { author: string }, login: string | null): boolean {
  if (!login || !pr.author) return false;
  return pr.author.toLowerCase() === login.toLowerCase();
}
