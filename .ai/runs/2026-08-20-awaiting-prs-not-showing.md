# Execution plan — show the awaiting PRs the inbox is hiding

- Date: 2026-08-20
- Slug: `awaiting-prs-not-showing`
- Branch: `jtomaszewski/awaiting-prs-not-showing`
- Base: `main`
- Engine: om-auto-create-pr (steps: 6, --loop: no)

## Goal

Stop the cockpit from saying nothing awaits your review while its own poll says two PRs do,
and make a PR GitHub still asks you for visible without opening a drawer and guessing.

## Scope

Reproduced on the user's cockpit. The daemon strip reads `last: 2 awaiting; 0 reviewed, 2 up
to date` and the body directly beneath it reads `Inbox empty — nothing awaits your review.`

What is actually going on:

- `searchAwaitingMe` returns 3 open PRs where the user's review is requested; one is a draft,
  so `mapSearchResults` drops it. Two remain: `fullstackhouse/groomershop-mercato#375` and
  `fullstackhouse/open-mercato#98`.
- Both already have local artifacts the user settled by hand — #375 `reviewed`, #98 `skipped`.
  Their `headSha` matches the live PR head, so `reviewPr` correctly reports them up to date.
- `Queue.tsx` builds `live` by filtering `SETTLED` out of the open artifacts. With both
  awaiting PRs settled, `live.length === 0` and the empty-state branch renders.

So the queue is filtering on "have you dealt with this locally" while the strip counts "does
GitHub still want you". Those two answers diverge permanently the moment you skip a PR or mark
one reviewed without sending, because cerber never writes to GitHub and the review request
never clears. Nothing in the cockpit reconciles them, so the work becomes invisible.

The fix keeps the local decision authoritative — a settled review stays settled — and makes
the divergence legible: the daemon publishes what its last successful discovery found, and the
cockpit names any awaiting PR its own filters are hiding.

## Non-goals

- Un-settling a review the user marked reviewed or skipped. That decision is theirs; this run
  makes it visible, it does not override it.
- Any new GitHub write. Discovery stays read-only.
- Touching the head-drift path. New commits already re-review a settled artifact back to
  `ready`, and it returns to the queue on its own — that works and is left alone.
- Persisting the awaiting set on the artifact. It is one search result per poll, not review
  state; putting it on the artifact would mean a schema bump and a write to every file every
  five minutes.

## Risks

- **A stale list reading as current truth.** The awaiting set is only as fresh as the last
  successful poll. Polling deliberately off must not leave an old list standing as a claim,
  and a failed poll must not silently present its predecessor as fresh.
- **Two sources for one number.** `lastSummary` counts search hits and the new list counts
  artifact ids. They are derived from the same `refs` in the same tick, so they must not be
  allowed to drift apart in future edits.

## Implementation Plan

### Phase 1 — The daemon publishes what it found

- 1.1 `DaemonStatus` gains `awaiting: string[]` — the artifact ids from the last successful
  discovery, set in `poll()` from the same `refs` that produce `lastSummary`. Cleared when the
  config's poll toggle is off (discovery turned off makes no claim); left standing when a poll
  errors, where `lastPollError` already says how fresh it is. Mirrored in `web/src/types.ts`;
  `/api/daemon` returns `status()` wholesale, so no endpoint change.
- 1.2 Tests for the bookkeeping: a successful poll publishes the ids, polling off clears them,
  a failed poll keeps the last good list.

### Phase 2 — The cockpit stops contradicting itself

- 2.1 `inbox.ts`: `hiddenAwaiting(list, daemon)` — the reviews GitHub still asks you for that
  the queue is not showing — and `hiddenAwaitingNote(hidden)`, the sentence that replaces the
  false empty state. Both pure and tested.
- 2.2 `Queue.tsx`: the empty state names them and reveals them in one click; drawer rows carry
  a `still awaiting you` tag and each drawer label counts them, so the same fact reads the same
  way whether or not the queue happens to be empty. One tag style in `styles.css`.

### Phase 3 — Gate

- 3.1 `pnpm typecheck && pnpm test && pnpm build`.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

PR: #15

### Phase 1: The daemon publishes what it found

- [x] 1.1 DaemonStatus.awaiting published from the last successful discovery — 6fd22dd
- [x] 1.2 Tests for publish, poll-off clear, and failed-poll retention — 6fd22dd

### Phase 2: The cockpit stops contradicting itself

- [x] 2.1 hiddenAwaiting + hiddenAwaitingNote in inbox.ts, with tests — efe8a54
- [x] 2.2 Truthful empty state, drawer tags and counts, tag style — efe8a54

### Phase 2b: Post-review

- [x] Post-review fix: README + CLAUDE.md now say a settled review can still be one GitHub asks you for — 39f1bc5

### Phase 3: Gate

- [x] 3.1 Full validation gate green — `pnpm typecheck && pnpm test && pnpm build`, 288 tests in 24 files
