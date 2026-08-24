# Lifecycle reference

What a review *is*, who writes it, when it changes, and when you see it.

The README tells the story; this is the reference you check when the story
isn't enough. Every rule below names the file it lives in, so a change in the
code that outdates a line here is findable.

---

## 1. Four writers, one file

Everything cerber knows about a PR is one JSON file:

```
~/.cerber/reviews/<owner>__<repo>__<number>.json      # the artifact (CERBER_HOME overrides ~/.cerber)
~/.cerber/config.json                                 # your settings
~/.cerber/autosend.ndjson                             # one line per auto-send decision
~/.cerber/src/<owner>__<repo>__<number>/              # the PR checkout (LRU, 8 kept)
```

Four things write the artifact, and most questions in this document are really
"which of these moved it":

| Writer | Where | What it may do |
| --- | --- | --- |
| **the poll** | `src/server/daemon.ts` | create stubs, archive, file, delete stubs, start drafts — and, with `--auto-send`, submit and mark `sent` |
| **startup** | `reconcileRunning`, `src/core/state.ts` | on boot, turn a leftover `running` into `failed` and error a pending chat turn |
| **the runner** | `src/runner/review.ts`, `chat.ts` | fill in summary / chapters / comments / verdict |
| **you** | the cockpit → `src/server/index.ts` | edit, mark reviewed/skipped, send, re-review, chat |
| **you** | the CLI → `src/cli/index.ts` | `review` (`--force` re-reviews) and `send`. That is all it writes — `export` only renders, `prune` only clears checkouts, and there is no edit, mark or chat |

There is no database and no migration step. The file is hand-editable; readers
are defensive and writers are atomic (tmp+rename, `src/core/state.ts`).

---

## 2. Statuses

Seven, from `ArtifactStatusSchema` in `src/core/artifact.ts`. Exactly one at a
time.

| Status | Means | Set by |
| --- | --- | --- |
| `awaiting` | GitHub asks you for this PR; nobody has drafted anything | poll (`stubArtifact`) |
| `running` | an AI run is in flight | runner, or the cockpit before it answers `202` |
| `ready` | a draft exists and wants you to read it | runner, on success |
| `reviewed` | **you** are done with it — or the poll filed it (see §5) | you, or poll |
| `skipped` | **you** decided not to review it | you |
| `sent` | the review reached GitHub | the cockpit's Send, `cerber send`, or auto-send |
| `failed` | the run errored | the runner; the cockpit's create/re-review catch handlers, for a failure before the runner owns the artifact; or restart reconciliation |

Two derived groupings drive most behaviour:

- **`SETTLED = [sent, reviewed, skipped]`** (`web/src/inbox.ts`) — out of the
  live queue.
- **`SETTLED_BY_YOU = [reviewed, skipped]`** (`src/runner/review.ts`) — a new
  push must not drag these back.

`archived` is *not* a status. It is `pr.state !== "OPEN"` — merged or closed —
and it takes a row out of every tab except **open requests**, which is computed
over *all* artifacts and so can still name an archived one GitHub is asking
about (`isArchived` / `hiddenAwaiting`, `web/src/inbox.ts`).

---

## 3. Transitions

Every *review* run goes through `running`; nothing reaches `ready` or `failed`
without it — so the machine reads most easily as three questions. (A chat turn
is the exception: it is an AI run too, but it leaves the status alone and lives
on `pendingChat` instead, because the review it is about is already finished.)

**What starts a run** — i.e. what enters `running`. The two forcing paths
ignore the freshness guard in §4; everything else obeys it. The re-review
button is refused only on `sent` and on `running`, where the endpoint answers
`409` because a run is already in flight:

```
(nothing)           ──you paste a URL, or `cerber review`──► running
awaiting            ──the poll, when auto-review is on────► running
ready | sent        ──the poll, once the head has moved───► running
failed              ──the poll, next time round───────────► running
any but `sent`      ──the cockpit's re-review button──────► running
anything            ──`cerber review --force`─────────────► running
```

**What a run becomes:**

```
running ──the AI answered──► ready
running ──it errored───────► failed
running ──cerber restarted─► failed   (reconcileRunning)
```

**And what happens to a finished draft** — all of these start at `ready`:

```
any unsent row ──you mark it────────────────► reviewed | skipped
ready ──the poll finds GitHub moved past it─► reviewed  (+ `filed`)
ready ──Send / `cerber send` / auto-send────► sent
```

Settling is the one that is not restricted to a finished draft: the cockpit
offers skip on `awaiting`, `running` and `failed` rows too, so a PR you have
decided about needs no draft first.

Notes on the edges that surprise people:

- **Pasting a URL saves `running`, never `awaiting`.** A pure stub in that
  window is exactly what the poll's reaper deletes, so the run is persisted up
  front (`src/server/index.ts`, `POST /api/reviews`).
- **A restart turns any `running` into `failed`** and marks a pending chat turn
  errored (`reconcileRunning`, `src/core/state.ts`). Nothing in a fresh process
  is actually running, so anything still marked so would wedge forever.
- **`failed` is retried by the poll** — it is neither settled nor
  head-sensitive, so the freshness guard below lets it through every time. Only
  by the poll, though: `reviewAll` runs solely when auto-review is on and solely
  over PRs the awaiting search returned, so a failed artifact GitHub has stopped
  asking about is never retried on its own.
- **Nothing transitions to `sent` except by a deliberate human act — the
  cockpit's Send button or `cerber send` — or by opt-in auto-send.** That is
  the one hard rule of the product.

---

## 4. When does the AI run?

`reviewPr` (`src/runner/review.ts`) is the single entry point. Before it spends
a token it checks the artifact already on disk:

1. `force`? → run. (The cockpit's **re-review** button always forces;
   `cerber review --force` too.)
2. Status in `SETTLED_BY_YOU` (`reviewed`, `skipped`)? → **skip**, log
   "use --force". *This is why marking a PR reviewed survives a push.*
3. Status in `HEAD_SENSITIVE` (`ready`, `sent`) **and** head SHA unchanged? →
   **skip** as up to date.
4. Otherwise → run.

So a `ready` **or `sent`** artifact on a PR that gets a new commit is meant to
be re-drafted by the next poll: `HEAD_SENSITIVE` only skips while the head is
*unchanged*. For a sent one that is the point — submitting cleared GitHub's
request, so a fresh one only ever arrives because someone asked for another
look (`review.test.ts`). Both need the PR to still be in the awaiting search:
`reviewAll(refs)` is fed the search results, so a PR you pasted by hand and
that GitHub isn't asking you about is never auto re-reviewed.

> ⚠ **Opening a review currently suppresses that re-draft.** The guard compares
> `existing.pr.headSha` against the PR's head, and the refresh that runs when
> you open a review writes the new head onto the artifact while leaving its
> status `ready` (`refreshArtifact`). So: the author pushes, you open the draft
> to look at it, and the poll now reads the row as up to date and never
> re-reviews it. Only the two forcing paths get past it — the re-review button
> and `cerber review --force`. The artifact keeps no
> record of which commit the *AI* actually read — `refresh.toSha` is the
> closest thing — so the guard has nothing else to compare against.

**A re-review that succeeds does not throw away your work.**
`carryOverComments` (`src/core/refresh.ts`) carries your own comments *and* AI
comments you edited onto the new diff, re-anchored. AI comments you didn't
touch are dropped — the new run just regenerated them.

> ⚠ **A re-review that *fails* does throw them away** — permanently. The run
> saves a fresh artifact with `comments: []` before it calls Claude, so your
> comments leave the disk at that moment and live only in the run's memory;
> `carryOverComments` puts them back on the success path, and the failure
> handler never reaches it. Tracked as
> [#37](https://github.com/fullstackhouse/cerber/issues/37); this warning goes
> when the fix lands.

### Re-review vs refresh — different things

| | **refresh** (`POST /api/reviews/:key/refresh`) | **re-review** (`POST /api/reviews/:key/rerun`) |
| --- | --- | --- |
| Costs | a PR fetch, plus a diff fetch only if the head moved | a full AI run |
| Changes | `diff`, `pr`, comment line anchors | everything the AI writes |
| Runs when | **you open a review** (automatic, `web/src/Detail.tsx`) | you press the button |
| Does nothing on | `sent`, `running`, or head unchanged — a `200` with `changed: false`, not an error | `sent`, or a run already in flight — these *are* errors (`409`) |

The re-review endpoint passes `force: true`, so an unchanged head is no
obstacle to it — the guard in §4 is what the *poll* and a plain `cerber review`
obey, not the button.

Refresh keeps comments *postable* against current code (`anchor.ts` matches
line **text**, not position). It forms no opinion about the new head: the
summary, chapters and verdict it carries across still describe the commit that
was actually reviewed. A re-review is what re-reads the new code. (A chat turn
can rewrite those same fields too — but from the conversation, not from a fresh
reading of a commit nobody has reviewed.)

---

## 5. When does a PR appear, and where?

Everything comes from `bucket()` in `web/src/inbox.ts`. One function, so a tab
count can never disagree with its own table.

Let `open` = artifacts with `pr.state === "OPEN"`, and
`live` = `open` minus `SETTLED`.

| Tab | Rows | Note |
| --- | --- | --- |
| **inbox** | `live` | everything still waiting on you |
| **awaiting** | `live` where status is `awaiting` or `running` | found, not drafted yet |
| **drafted** | `live` where status is anything else | `ready` — **and `failed`** |
| **open requests** | `hiddenAwaiting` | see below |
| **settled** | `open` where status is `reviewed` or `skipped` | |
| **sent** | `open` where status is `sent` | |
| **archived** | everything with `pr.state !== "OPEN"` | excluded from every tab above except `open requests` |

Filed tabs only appear while they hold something, so the one you are standing
on can empty under you; `shownTab` then falls back to the inbox. That is a
stable place to land, not a claim about where the row went — a row leaving
`open requests` may well have moved to another filed tab.

**Open requests** is the one tab that is a question about GitHub rather than a
place a review is filed, so it deliberately overlaps the others: it is the
rows GitHub still requests from you that the queue is *not* showing — i.e. you
took them out of the live queue locally — settled, archived, or sent — while
GitHub still lists you as a requested reviewer. Usually that is because
settling here reaches nothing on GitHub; a sent row can land here too, when a
review was submitted and someone then asked you for another one. Without it the cockpit would say "nothing
awaits you" over a poll that had just counted two.

**Sort order** (`STATUS_ORDER`): `ready`, `awaiting`, `running`, `failed`,
`reviewed`, `skipped`, `sent` — newest first inside each band. The `‹ ›` arrows
walk `walkable()`: open, unsettled rows only.

### Things that remove a row without you touching it

| Cause | Effect | Where |
| --- | --- | --- |
| PR merged or closed | `pr.state` updated → **archived** tab | `syncQueue` |
| A pure stub leaves the awaiting search, PR still open | **deleted** — it held no work | `syncQueue` / `isPureStub` |
| GitHub moved past a finished draft | status → `reviewed`, `filed` set | `fileIfSettledElsewhere` |
| Auto-send is on and the draft qualified | status → `sent` (the **sent** tab) | `handleAutoSend` |

A **pure stub** is `awaiting`, with no comments and **`run === null`** — it
does not look at chapters. The `run` block is what makes this safe: the create
endpoint persists one before it answers, so a review you pulled in by hand is
never a pure stub even in the minutes before its first output lands. Search lag
at worst re-creates a deleted stub next poll.

### Filing: the three reasons

Only a `ready`, unsent draft can be filed, and only if it wasn't your own later
request (`filedByYourAct`). Checked in order of how much each says
(the guards in `src/server/daemon.ts`; the `FiledReason` type itself in
`src/core/artifact.ts`):

1. **`own-review`** — you submitted a review on github.com. Strongest: GitHub
   counts it.
2. **`own-reply`** — you commented and nobody has answered since. Not a review
   to GitHub, but the ball is with the author.
3. **`request-withdrawn`** — nobody is asking any more. The weakest evidence
   (a search index's silence), so it is confirmed against the PR itself with
   `fetchReviewRequests`, and only applies to drafts the poll wrote on its own.

Someone *answering* your comment files nothing — that reply is addressed to
you. State checks are leashed to one per artifact per 30 minutes and capped
per poll.

### "Whose move is it"

Independent of status. Each poll reads the PR conversation per awaiting PR
(`classifyReply`) and publishes it on `status.awaiting`: `you haven't replied`
/ `waiting on them` / `they replied last`, or `unknown` if the read failed.
Bots don't count as an answer. This is a *label*, not a filter — it never
hides a row.

---

## 6. What is persisted, and when

A run writes the artifact more than once on purpose — an interrupted run must
leave something behind:

1. **On start** — `running`, with a `run` block (`startedAt`, `withSource`,
   `trusted`, `trigger`).
2. **`trigger`** is `daemon` or `user` on anything written since the field
   existed; it is `null` on older artifacts, and the filing guards treat that
   legacy case as "no claim". It is what lets filing spare a second opinion you
   deliberately asked for.
3. **On success** — `ready`, plus `summary`, `chapters`, `comments`, `verdict`,
   `run.costUsd`, and `run.sessionId` — the Claude session chat turns resume,
   recorded **only for a source-backed run** (`source ? review.sessionId : null`),
   since there is no checkout for a `--no-source` turn to resume into.
4. **On failure** — `failed`, with `run.error` — but only for failures *after*
   step 1. `reviewPr` fetches the diff and resolves trust and the checkout
   before it first saves, so a failure there leaves no `failed` row behind for
   a direct caller (`cerber review`, the poll) to find. The cockpit's endpoints
   close that hole themselves: create and re-review both persist `running`
   before answering `202`, and their catch handlers mark it `failed`.

Written by other paths:

- Every comment edit, add and drop is saved immediately (`editedByUser` is set
  when you rewrite an AI comment — it is the calibration signal *and* what
  makes the comment survive a re-review).
- A chat turn writes `pendingChat` **before** it starts (so a reload mid-turn
  still shows it), streams `pendingChat.progress`, then folds its result onto
  whatever the artifact says now (`mergeConcurrentEdits`) and appends a
  `ChatTurn`. `preChat` is the one snapshot taken before the first turn.
- Send writes `sent` and `calibration` (what the AI proposed vs what you sent).
- Refresh writes `refresh` (`fromSha`, `toSha`, `moved`, `drifted`).

**No HTTP request is ever held open for an AI run.** A review and a chat turn
both answer `202` and put their state on the artifact for the cockpit to poll —
failures included, since there is no response left to hand them to.

---

## 7. Settings that change any of this

`~/.cerber/config.json`, zod-validated, and mostly live. The poll re-reads it
every tick and acts on `poll` and `autoReview`, so the cockpit's toggles apply
without a restart; `trust` is re-read by every `reviewPr` call, so a rule you
add binds the next run. Only `intervalMinutes`, `parallel` and `repos` are
captured by `startDaemon` and need a restart. Absent = defaults, which is a working state,
not an open one: polling and auto-review are on, `trust` is empty (every run
read-only) and auto-send does nothing but log.

| Key | Default | Effect |
| --- | --- | --- |
| `daemon.poll` | `true` | discover awaiting PRs at all |
| `daemon.autoReview` | `true` | draft a review for what the poll finds |
| `daemon.intervalMinutes` | `5` | |
| `daemon.parallel` | `3` | concurrent runs |
| `daemon.repos` | `[]` | empty = everything `gh` can see |
| `trust` | `[]` | whose PRs may run commands: `@login`, `@org/team`, `@org/*`, and `!`-prefixed denials (`!@org/team`) that carve an exception out of a broader grant. Denials win |

CLI flags cap the config, never raise it: `--no-poll`, `--no-auto-review`,
`--no-source`, `--no-trust`.

**Auto-send** is deliberately narrow (`src/core/autosend.ts`): only `ready`,
only an `approve` verdict, only with **zero** standing blocker findings, only
at or above `--auto-send-threshold` (default 90, clamped to 50–100), never a
re-send. Without `--auto-send` the daemon still evaluates in **shadow mode**
and logs what it *would* have sent; the flag is what makes it actually send.
Either way the decision — including the declines and why — appends to
`autosend.ndjson`. It is evaluated per *run*, not per draft: `handleAutoSend`
fires only where `reviewAll` actually produced a review, so a `ready` draft the
freshness guard skipped is not re-judged or re-logged on later polls.

---

## 8. Quick answers

**"Why is this PR not in my inbox?"** — In order: you already sent the review
(the **sent** tab — `sent` is in `SETTLED` too), it's settled (`reviewed` /
`skipped` — the **settled** tab, and check **open requests**), the PR is
merged/closed (**archived**), the poll is off, or GitHub isn't requesting your
review.

**"Why did this PR come back?"** — Either the author pushed and its status was
`ready` or `sent` (both head-sensitive, so a moved head re-drafts them), or its
status was `awaiting` or `failed`, which the poll retries with no push involved
at all. Only `reviewed` and `skipped` never come back on their own.

**"Why won't it re-review?"** — Both causes are the freshness guard in §4, so
they only bind the callers that obey it (the poll, plain `cerber review`):
status is `reviewed`/`skipped`, or the head SHA is unchanged on a `ready`/`sent`
row. `cerber review --force` forces past both. The cockpit's re-review button
forces too, but refuses a `sent` artifact outright — that record is not
rewritten from the UI, though the poll will still re-draft it once the head
moves.

**"Why does it say reviewed when I never touched it?"** — The poll filed it;
`filed.reason` says which of the three cases. The draft is untouched and still
sendable.

**"Where did my edited comment go after a re-review?"** — It's still there,
re-anchored. Only untouched AI comments are regenerated.
