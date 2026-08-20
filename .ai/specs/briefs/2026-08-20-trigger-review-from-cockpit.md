# Start a review from the cockpit: stop filtering drafts out of inbox discovery, and add a paste-a-PR box

- Date: 2026-08-20
- Category: feature
- Priority signal: high — the cockpit currently reports an empty inbox while GitHub holds an open review request; there is no in-product way to review any PR outside the daemon's search
- Risk signal: medium — touches inbox discovery (which feeds the auto-send path) and adds the first artifact-creating HTTP endpoint
- Routing: `Next: om-auto-create-pr "Start a review from the cockpit: stop filtering drafts out of inbox discovery, and add a paste-a-PR box that creates the artifact and runs immediately — brief: .ai/specs/briefs/2026-08-20-trigger-review-from-cockpit.md"`

## Problem

GitHub asks the user for a review that cerber can neither show nor start. The trigger case is `fullstackhouse/open-mercato#54`: it requests `jtomaszewski`'s review, but it is a draft, so `mapSearchResults` (`src/core/gh.ts:132`) drops it with an unconditional `.filter((r) => !r.isDraft)`. It never becomes an artifact, and because it is absent from `status.awaiting` as well, the cockpit's hidden-awaiting note cannot even tell the user it exists. The cockpit shows an empty inbox while GitHub holds an outstanding request.

The second half of the problem is broader than drafts. The cockpit can only *re-run* a review: `POST /api/reviews/:key/rerun` (`src/server/index.ts:319`) returns 404 unless an artifact already exists. New artifacts appear only via the `cerber review <url>` CLI or daemon discovery, so any PR outside `--review-requested=@me` — your own PRs, a colleague's you were not requested on, an older one you want a second read of — requires dropping to a terminal. The cockpit is the product surface; the CLI round-trip breaks the loop.

## Agreed direction

Ship both halves in **one PR**. They are independently deployable, and the user was presented with the argument for splitting (the draft fix is a `fix:` one-liner that could ship immediately, and merging it with a `feat:` means semantic-release reports only the minor) and explicitly chose one PR: the release-note nuance is not worth two round trips.

### (a) Drafts belong in the inbox

Delete the `.filter((r) => !r.isDraft)` in `mapSearchResults` and flip the corresponding assertion in `src/runner/pool.test.ts:50` ("maps results and excludes drafts").

The load-bearing justification — record it in the PR, because it is stronger than user preference:

1. `src/core/config.ts:17` **already documents this behavior**: *"the cockpit is an inbox: open it and the PRs awaiting your review are already there, drafts and all."* The filter contradicts documentation the repo ships. This is "Never ship a default that half-works" applied to a default that was written down and never wired up.
2. The search is already `--review-requested=@me`. A draft carrying an explicit review request is not work-in-progress the author wants left alone — the author deliberately pressed the button. The draft filter is redundant with a stronger filter that runs first.

Drafts are then treated identically to any other PR: auto-review on, desktop notification on, and a `draft` badge in the queue UI so the user can see what they are looking at.

The badge requires schema work, not just a CSS class: `PrInfoSchema` (`src/core/artifact.ts:41`) has no `isDraft` field, and `fetchPrInfo` does not request it from `gh pr view`. Both need it. `DiscoveredPr` already carries `isDraft` from the search.

### (b) A paste-a-PR box in the cockpit

A new `POST /api/reviews` endpoint plus an input on the Queue screen. It takes a PR reference, creates the artifact, and starts the review run immediately — not "add to queue for later" (see Non-goals).

Accepted input forms: **full GitHub PR URL** and **`owner/repo#123`**, both via the existing `parsePrRef` (`src/core/gh.ts:17`). Bare numbers are out of scope (see Resolved unknowns).

Three hard requirements, each of which the implementation will get wrong by default:

1. **Validate in-request.** Call `fetchPrInfo` synchronously and answer `502` with `gh`'s error message on failure. Because the run itself is detached ("Don't hold an HTTP request open for an AI run"), a typo'd URL, a private repo, or an unauthenticated `gh` would otherwise produce a failure with no artifact to attach it to and no response left to report it on. The rerun endpoint escapes this only because its artifact already exists. The `fetchPrInfo` call is needed anyway to populate the stub's `title`/`url`, so this costs nothing.

2. **Persist `status: "running"` with a non-null `run` block synchronously, before answering 202.** This is the subtle one. `reviewPr` (`src/runner/review.ts`) does `fetchPrInfo` (113) → `fetchPrDiff` (128) → `resolveTrust` (130, network membership calls) → `prepareCheckout` (137, a git clone) **before** the `saveArtifact` at 188 that first writes `status: "running"`. On a large repo that window is minutes; the default poll interval is 5 minutes. A poll landing inside it sees an artifact with `status: "awaiting"`, no comments and `run: null` — a pure stub (`daemon.ts:143`) that is not in `awaitingIds` and whose PR is `OPEN` — and calls `deleteArtifact` (`daemon.ts:231`). The cockpit, which just navigated to that key, starts 404ing mid-run, and the artifact reappears when the run finally saves. The rerun endpoint already does the weaker version of this and explains why in a comment (`src/server/index.ts:333-348`); the new endpoint needs the stronger version because its artifact is brand new.

3. **An existing artifact for that PR opens it rather than duplicating.** Fewest clicks: paste a PR you already reviewed and you land on the review.

### Explicitly weighed and rejected

- **Build nothing.** `cerber review <url>` works today and the user could keep using it. Rejected because the cockpit is the product surface and the terminal round-trip breaks the loop — and because the empty-inbox-while-GitHub-waits case is a wrong default, not a missing convenience. Restated without the proposed solution, the problem survives intact: GitHub asks for a review cerber can neither show nor start.
- **Only fix the draft filter.** Resolves #54 but leaves cerber unable to review any PR it was not asked to review.
- **Only add the paste box.** Resolves #54 as a side effect but leaves cerber ignoring PRs GitHub explicitly assigned to the user — the wrong default stays wrong.

## Resolved unknowns

| Question | Answer (from the conversation) |
|----------|--------------------------------|
| Should the daemon auto-review drafts, or list them and wait for a click? | Auto-review them, identically to any other PR. Desktop notification stays on too. The only difference is a `draft` badge in the queue. |
| Should auto-send be gated on drafts? `evaluateAutoSend` (`src/core/autosend.ts:13`) has no draft check and cannot have one today — `PrInfoSchema` lacks `isDraft` and GitHub reports a draft's `state` as `OPEN`. Removing the search filter therefore extends the one GitHub write path to drafts for anyone running `--auto-send`. | **No gating — leave `evaluateAutoSend` exactly as it is. This is a deliberate, explicitly-weighed decision, not an oversight.** The reasoning: an explicit review request on a draft is consent enough. The risk was put to the user directly, alongside the alternatives (gate auto-send on drafts; or hide Send on drafts entirely), and this option was chosen. **Do not "fix" this while implementing.** If a future change adds `isDraft` gating to auto-send, it must be a deliberate reversal with its own justification. |
| One PR or two? | One. The user was shown the case for splitting (`fix:` one-liner ships immediately vs. being absorbed into a `feat:` minor) and chose one PR. |
| Should the paste box accept a bare number (`54`)? | **No — drop bare numbers.** `parsePrRef` throws on a bare number without a `repoFlag`, the cockpit has no repo context, and `config.daemon.repos` defaults to `[]`. The available fallback — resolve from `daemon.repos` when it holds exactly one entry — works only for users with exactly one configured repo, which is a default that half-works. URL and `owner/repo#N` cover the paste-from-browser case, which is the actual workflow. |

## Non-goals

- **No draft-specific auto-send gating.** See the Resolved unknowns table — deliberate.
- **No "add to queue without reviewing" mode.** The reaper (`daemon.ts:221-233`) deletes pure stubs that are absent from the awaiting search, so a queued-but-unreviewed pasted PR would silently vanish on the next poll. Paste means review now.
- **No repo-picker or repo-context UI in the cockpit.** That is what makes bare numbers out of scope; do not add it to enable them.
- **No new GitHub write calls.** The hard rule holds: Send stays the only write, and this PR does not touch it.
- **No changes to the rerun, chat, refresh or send endpoints** beyond what sharing helpers requires.

## Affected areas (if known)

- `src/core/gh.ts` — `mapSearchResults` (remove the draft filter); `fetchPrInfo` (request `isDraft` from `gh pr view`); `parsePrRef` is reused unchanged
- `src/core/artifact.ts` — `PrInfoSchema` gains `isDraft` (defaulted, so existing artifacts keep loading — state files are user-editable and read defensively)
- `src/server/index.ts` — new `POST /api/reviews`; follows the detached-run + 202 + poll pattern of `/api/reviews/:key/rerun` (319), including its `withSource` / `trust` option handling
- `src/server/daemon.ts` — no behavior change required, but `syncQueue`'s reaper comment at 232 needs updating (see Watch-outs)
- `src/runner/pool.test.ts:50` — the "excludes drafts" assertion inverts
- `web/src/api.ts` — a `createReview(input)` call
- `web/src/Queue.tsx` — the paste input, its error state, navigation to the created key, and the `draft` badge
- `web/src/styles.css` — badge and input styling

## Watch-outs for the implementer

These came out of an adversarial review of this brief. None blocks the work; all three will bite later if unrecorded.

1. **The draft badge goes stale in the wrong direction.** `syncQueue` skips artifacts that already exist (`daemon.ts:209`), so a PR discovered as a draft never takes a later search result. Mark a PR ready-for-review and it keeps its draft badge until something re-fetches its `PrInfo`. Either refresh `isDraft` on the existing-artifact path or accept it knowingly — but a badge that says "draft" about a ready PR is worse than a badge that says nothing.

2. **The paste box creates a second provenance and quietly breaks a reaper invariant.** Today every artifact exists because GitHub asked you, which is exactly what makes `daemon.ts:232`'s log line — *"no longer awaiting your review — removed from the queue"* — a true statement. After this change, artifacts exist for two different reasons and that message is only true for one of them. It stays safe today by accident: a pasted artifact always has `run != null` by the time a poll can see it (requirement 2 above), so `isPureStub` returns false. Leave a comment at `isPureStub` saying so, or the next person to touch it will delete the user's pulled-in reviews.

3. **Draft churn thrashes the checkout cache.** Drafts are the highest-churn PRs, `reviewPr` re-runs on every `headSha` change, each run does a fresh checkout, and the LRU is 8 (`src/core/checkout.ts`). Two actively-pushed drafts will evict each other and re-review on every poll. Given the project's quality-over-token-thrift stance this is an accepted cost, not a blocker — but it is the mechanism that would make the user regret part (a), so it is worth watching after the first week rather than discovering by surprise.

4. **Pasting an already-sent PR is a dead end.** Requirement 3 opens the existing artifact, but rerun returns 409 on a `sent` artifact (`src/server/index.ts:323`), so there is no way to review that PR again from the cockpit. Out of scope to fix here; note it if the UI would otherwise present a disabled button with no explanation.
