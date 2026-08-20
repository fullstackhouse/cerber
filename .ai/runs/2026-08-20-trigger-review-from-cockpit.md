# Execution plan — start a review from the cockpit

- Date: 2026-08-20
- Slug: `trigger-review-from-cockpit`
- Branch: `jtomaszewski/trigger-review-from-ui`
- Base: `main`
- Source brief: `.ai/specs/briefs/2026-08-20-trigger-review-from-cockpit.md`
- Engine: om-auto-create-pr (steps: 13, --loop: no)

## Goal

Make the cockpit able to *start* a review, and stop it hiding PRs GitHub has explicitly asked the user to review. Today `POST /api/reviews/:key/rerun` 404s unless an artifact already exists, so every new review begins in a terminal; and `mapSearchResults` drops draft PRs unconditionally, so a draft with an outstanding review request (the trigger case, `fullstackhouse/open-mercato#54`) can never enter the inbox — the cockpit reports an empty queue while GitHub holds a request.

## Scope

Two halves, shipped as one PR per the brief's recorded decision:

1. **Drafts belong in the inbox.** Delete the draft filter; treat a draft identically to any other PR (auto-review on, notification on) with a `draft` badge in the queue.
2. **A paste-a-PR box.** A new `POST /api/reviews` endpoint plus a Queue-screen input that accepts a PR URL or `owner/repo#N`, creates the artifact, and starts the run immediately.

### Non-goals

- No draft-specific gating on auto-send. `evaluateAutoSend` stays exactly as it is — this is a deliberate, user-confirmed decision recorded in the brief, not an oversight. Do not "fix" it here.
- No "add to queue without reviewing" mode — the reaper would delete it.
- No repo-picker UI, and therefore no bare-number paste input.
- No new GitHub write calls; Send remains the only one.

## Implementation plan

### Phase 1 — Draft PRs reach the inbox

Adds `isDraft` to the artifact schema, removes the filter, and keeps the flag honest.

- **1.1** Add `isDraft: z.boolean().default(false)` to `PrInfoSchema` (`src/core/artifact.ts`) and request `isDraft` in `fetchPrInfo`'s `gh pr view --json` field list (`src/core/gh.ts:52`). Defaulted so existing artifacts on disk keep loading — state files are user-editable and read defensively.
- **1.2** Delete `.filter((r) => !r.isDraft)` from `mapSearchResults` (`src/core/gh.ts:132`), update its doc comment, and invert the `pool.test.ts:50` assertion ("maps results and excludes drafts") to assert drafts are now included.
- **1.3** Carry `isDraft` from `DiscoveredPr` into `stubArtifact`'s `pr` block (`src/server/daemon.ts:103`).
- **1.4** Keep `isDraft` fresh — the badge must not go stale when a PR turns ready. Two points, both free of extra GitHub calls: in `syncQueue`, the existing-artifact skip (`daemon.ts:209`) refreshes `pr.isDraft` from the search result it already holds; and the periodic state refresh (`daemon.ts:249`) already calls `fetchPrInfo` but writes back only `pr.state` — carry `isDraft` through too.
- **1.5** Render a `draft` badge on queue rows in `web/src/Queue.tsx` (plus `web/src/types.ts` and `web/src/styles.css`).

### Phase 2 — Start a review from the cockpit

- **2.1** `POST /api/reviews` in `src/server/index.ts`: parse the body's reference with `parsePrRef` (URL or `owner/repo#N`; a bare number is a 400 with a message saying to paste the full URL), then validate against GitHub with `fetchPrInfo` **in-request**, answering `502` with `gh`'s message on failure. Because the run is detached there is no response left to report a bad paste on, and the `fetchPrInfo` result is needed anyway to populate the artifact.
- **2.2** If an artifact already exists for that PR, return it with `200` rather than creating a duplicate or restarting a run — the cockpit navigates to the existing review.
- **2.3** Persist the new artifact with `status: "running"` **and** a non-null `run` block synchronously, before answering `202`; only then kick off the detached `reviewPr`, mirroring the rerun endpoint's failure handling (`index.ts:357-368`). Without this the artifact spends the minutes `reviewPr` needs for `fetchPrDiff` → `resolveTrust` → `prepareCheckout` as a pure stub, and a poll landing in that window deletes it mid-run. Add a comment at `isPureStub` (`daemon.ts:143`) recording that artifacts now have two provenances and why the reaper is still safe.
- **2.4** `createReview(input)` in `web/src/api.ts`.
- **2.5** Paste box on the Queue screen (`web/src/Queue.tsx` + `styles.css`): input, submit, inline error surfacing the server's message, and navigation to the created or existing review.

### Phase 3 — Tests and validation

- **3.1** Server tests for `POST /api/reviews`: rejects an unparseable reference, surfaces a `fetchPrInfo` failure as 502, returns the existing artifact instead of duplicating, and — the regression that matters — persists `status: "running"` with a non-null `run` before responding, so the reaper cannot classify it as a pure stub.
- **3.2** Tests for the draft path: `mapSearchResults` includes drafts, `stubArtifact` carries `isDraft`, and both refresh points in `syncQueue` clear a stale draft flag when a PR turns ready.
- **3.3** Full validation gate: `pnpm typecheck`, `pnpm test`, `pnpm build`.

## Risks

- **Auto-send reaches drafts.** Removing the filter means a user running `--auto-send` can have cerber post an APPROVE to a draft. This was raised explicitly and accepted by the user (an explicit review request is consent enough) and is recorded in the brief. Flagged here so a reviewer sees it was a decision, not an accident.
- **Draft churn.** Drafts push most; `reviewPr` re-runs on every `headSha` change and each run takes a checkout against an LRU of 8, so a couple of hot drafts will thrash the cache. Accepted under the project's quality-over-token-thrift stance; worth watching after a week of real use.
- **Two artifact provenances.** After this PR, an artifact may exist because the user pasted it rather than because GitHub asked. The reaper stays correct only because a pasted artifact always has `run != null` — hence the comment in 2.3.
- **Pasting an already-sent PR is a dead end.** 2.2 opens the existing artifact, but rerun 409s on a `sent` one, so there is no way to review it again. Out of scope; noted in the brief.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Draft PRs reach the inbox

- [x] 1.1 Add isDraft to PrInfoSchema and fetch it in fetchPrInfo — d15c108
- [x] 1.2 Remove the draft filter from mapSearchResults and invert its test — d15c108
- [x] 1.3 Carry isDraft into stubArtifact — d15c108
- [x] 1.4 Keep isDraft fresh in both syncQueue refresh points — d15c108
- [x] 1.5 Draft badge in the cockpit queue — d15c108

### Phase 2: Start a review from the cockpit

- [x] 2.1 POST /api/reviews with in-request validation — 1c0c4be
- [x] 2.2 Return the existing artifact instead of duplicating — 1c0c4be
- [x] 2.3 Persist running state synchronously before the 202 — 1c0c4be
- [x] 2.4 createReview in the web API client — 1c0c4be
- [x] 2.5 Paste box on the Queue screen — 1c0c4be

### Phase 3: Tests and validation

- [x] 3.1 Server tests for POST /api/reviews — 7c5dfe2
- [x] 3.2 Tests for the draft discovery and refresh paths — 7c5dfe2
- [x] 3.3 Full validation gate — 7c5dfe2
- [x] Post-review fix: start the review on a pure stub, guard with isReviewRunning, clear the paste error on edit — 3102503
