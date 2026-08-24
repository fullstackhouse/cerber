# Lifecycle reference

What a review *is*, who writes it, when it changes, and when you see it.

The README tells the story; this is the reference you check when the story
isn't enough. Every rule below names the file it lives in, so a change in the
code that outdates a line here is findable.

---

## 1. Three writers, one file

Everything cerber knows about a PR is one JSON file:

```
~/.cerber/reviews/<owner>__<repo>__<number>.json      # the artifact (CERBER_HOME overrides ~/.cerber)
~/.cerber/config.json                                 # your settings
~/.cerber/autosend.ndjson                             # one line per auto-send decision
~/.cerber/src/<owner>__<repo>__<number>/              # the PR checkout (LRU, 8 kept)
```

Three things write the artifact, and every question in this document is really
"which of these three moved it":

| Writer | Where | What it may do |
| --- | --- | --- |
| **the poll** | `src/server/daemon.ts` | create stubs, archive, file, delete stubs, start drafts |
| **the runner** | `src/runner/review.ts`, `chat.ts` | fill in summary / chapters / comments / verdict |
| **you** | cockpit → `src/server/index.ts`, or the CLI | edit, mark, send, re-review, chat |

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
| `sent` | the review reached GitHub | Send button, or auto-send |
| `failed` | the run errored | runner, or restart reconciliation |

Two derived groupings drive most behaviour:

- **`SETTLED = [sent, reviewed, skipped]`** (`web/src/inbox.ts`) — out of the
  live queue.
- **`SETTLED_BY_YOU = [reviewed, skipped]`** (`src/runner/review.ts`) — a new
  push must not drag these back.

`archived` is *not* a status. It is `pr.state !== "OPEN"` — merged or closed —
and it overrides every tab (`isArchived`, `web/src/inbox.ts`).

---

## 3. Transitions

```
                  poll finds it                    run succeeds
       (nothing) ───────────────► awaiting ───────────────────► ready
            │                        │  ▲                        │
   you paste a URL / cerber review   │  │ re-review (force)      │
            │                        ▼  │                        │
            └──────────────────► running ┴────────────► failed ──┘
                                              run errors    ▲
                                                            │ restart while running
   ready ──you mark reviewed / skipped──► reviewed | skipped
   ready ──poll finds GitHub moved past it──────► reviewed (+ filed)
   ready ──Send / auto-send────────────────────► sent
```

Notes on the edges that surprise people:

- **Pasting a URL saves `running`, never `awaiting`.** A pure stub in that
  window is exactly what the poll's reaper deletes, so the run is persisted up
  front (`src/server/index.ts`, `POST /api/reviews`).
- **A restart turns any `running` into `failed`** and marks a pending chat turn
  errored (`reconcileRunning`, `src/core/state.ts`). Nothing in a fresh process
  is actually running, so anything still marked so would wedge forever.
- **`failed` is retried by the next poll** — it is neither settled nor
  head-sensitive, so the freshness guard below lets it through every time.
- **Nothing transitions to `sent` without either a human click or opt-in
  auto-send.** That is the one hard rule of the product.

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

So a `ready` draft on a PR that gets a new commit **is re-drafted
automatically** by the next poll — but only if that PR is still in the awaiting
search. `reviewAll(refs)` is fed the search results, so a PR you pasted by hand
and that GitHub isn't asking you about is never auto re-reviewed.

**A re-review does not throw away your work.** `carryOverComments`
(`src/core/refresh.ts`) carries your own comments *and* AI comments you edited
onto the new diff, re-anchored. AI comments you didn't touch are dropped — the
new run just regenerated them.

### Re-review vs refresh — different things

| | **refresh** (`POST /api/reviews/:key/refresh`) | **re-review** (`POST /api/reviews/:key/rerun`) |
| --- | --- | --- |
| Costs | one diff fetch | a full AI run |
| Changes | `diff`, `pr`, comment line anchors | everything the AI writes |
| Runs when | **you open a review** (automatic, `web/src/Detail.tsx`) | you press the button |
| Refuses on | `sent`, `running`, or head unchanged | `sent`, or a run already in flight |

Refresh keeps comments *postable* against current code (`anchor.ts` matches
line **text**, not position). The summary, chapters and verdict still describe
the commit that was actually reviewed — only a re-review updates the opinion.

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
| **archived** | everything with `pr.state !== "OPEN"` | wins over every other tab |

Filed tabs only appear while they hold something; standing on one that empties
drops you back to the inbox (`shownTab`).

**Open requests** is the one tab that is a question about GitHub rather than a
place a review is filed, so it deliberately overlaps the others: it is the
rows GitHub still requests from you that the queue is *not* showing — i.e. you
settled or archived them locally, and since cerber never writes to GitHub, the
request outlived your decision. Without it the cockpit would say "nothing
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

A **pure stub** is `awaiting` with no comments and no chapters. Search lag at
worst re-creates it next poll.

### Filing: the three reasons

Only a `ready`, unsent draft can be filed, and only if it wasn't your own later
request (`filedByYourAct`). Checked in order of how much each says
(`src/server/daemon.ts`, `FiledReason`):

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
2. **`trigger`** is `daemon` or `user`. It is what lets filing spare a second
   opinion you deliberately asked for.
3. **On success** — `ready`, plus `summary`, `chapters`, `comments`, `verdict`,
   `run.sessionId` (the Claude session, so chat turns resume it), `run.costUsd`.
4. **On failure** — `failed`, with `run.error`.

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

`~/.cerber/config.json`, zod-validated, re-read **every poll** — cockpit
toggles apply without a restart. Absent = defaults, all on.

| Key | Default | Effect |
| --- | --- | --- |
| `daemon.poll` | `true` | discover awaiting PRs at all |
| `daemon.autoReview` | `true` | draft a review for what the poll finds |
| `daemon.intervalMinutes` | `5` | |
| `daemon.parallel` | `3` | concurrent runs |
| `daemon.repos` | `[]` | empty = everything `gh` can see |
| `trust` | `[]` | `@login`, `@org/team`, `@org/*` — whose PRs may run commands |

CLI flags cap the config, never raise it: `--no-poll`, `--no-auto-review`,
`--no-source`, `--no-trust`.

**Auto-send** is deliberately narrow (`src/core/autosend.ts`): only `ready`,
only an `approve` verdict, only with **zero** standing blocker findings, only
at or above `--auto-send-threshold` (default 90, clamped to 50–100), never a
re-send. Without `--auto-send` the daemon still evaluates every finished draft
in **shadow mode** and logs what it *would* have sent; the flag is what makes
it actually send. Either way every decision — including the declines and why —
appends to `autosend.ndjson`.

---

## 8. Quick answers

**"Why is this PR not in my inbox?"** — In order: it's settled (`reviewed` /
`skipped` — check the settled tab, and open requests), the PR is merged/closed
(archived), the poll is off, or GitHub isn't requesting your review.

**"Why did this PR come back?"** — The author pushed, and its status was
`ready` or `awaiting`. `reviewed` and `skipped` never come back on their own.

**"Why won't it re-review?"** — Status is `reviewed`/`skipped`, or head SHA is
unchanged and status is `ready`/`sent`. The re-review button forces past both;
a sent review is never re-run.

**"Why does it say reviewed when I never touched it?"** — The poll filed it;
`filed.reason` says which of the three cases. The draft is untouched and still
sendable.

**"Where did my edited comment go after a re-review?"** — It's still there,
re-anchored. Only untouched AI comments are regenerated.
