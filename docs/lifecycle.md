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
| **you** | the cockpit → `src/server/index.ts` | edit, mark reviewed/skipped, send, re-review, chat — and, just by opening a review, the automatic refresh that rewrites `pr`, `diff`, the comment anchors and `refresh` |
| **you** | the CLI → `src/cli/index.ts` | `review` (`--force` re-reviews) and `send`. That is all it writes — `export` only renders, `history` only reads, `prune` only clears checkouts, and there is no edit, mark or chat |

There is no database and no migration step. The file is hand-editable; readers
are defensive and writers are atomic (tmp+rename, `src/core/state.ts`). Which
of the four moved a given row, and when, is on the artifact itself: every write
appends to its `history` (§6).

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

`archived` is *not* a status. It is `pr.state !== "OPEN"` — merged or closed.
It moves a row out of the live tabs and out of **settled** and **sent**, and
into **archived**. The one tab it does not exclude a row from is **open
requests**, which is computed over *all* artifacts and so can still name an
archived PR GitHub is asking about (`isArchived` / `hiddenAwaiting`,
`web/src/inbox.ts`).

---

## 3. Transitions

Every *review* run goes through `running`; nothing reaches `ready` or `failed`
without it — so the machine reads most easily as three questions. (A chat turn
is the exception: it is an AI run too, but it leaves the status alone and lives
on `pendingChat` instead. Nothing restricts it to a finished draft either —
`/chat` refuses only a sent artifact and one already busy, so an `awaiting` or
`failed` row can be talked about and keeps its status while the turn runs.)

**What starts a run** — i.e. what enters `running`. The two forcing paths
ignore the freshness guard in §4; everything else obeys it. The re-review
button is refused on `sent`, and on a run the *same process* is already
running — the `409` comes from `isReviewRunning`, an in-memory claim
(`src/runner/inflight.ts`), not from the persisted status, so a `cerber review`
going in another terminal is invisible to it:

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

**And what settles a row.** The last two need a finished draft; the first
does not:

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
- **A restart turns a leftover `running` into `failed`** and marks a pending
  chat turn errored (`reconcileRunning`, `src/core/state.ts`). Nothing in a
  fresh process is actually running, so anything still marked so would wedge
  forever. `serve` does it before it starts anything that polls, and
  reconciliation also skips any run this process actually owns (`inUse`), so a
  first tick that overlaps it cannot have "interrupted" stamped over a review
  that has just legitimately begun.
- **`failed` is retried automatically** — it is neither settled nor
  head-sensitive, so the freshness guard below lets it through every time. Only
  by the poll, and only on its terms: `reviewAll` runs solely when auto-review
  is on and solely over PRs the awaiting search returned, so a failed artifact
  GitHub has stopped asking about is never picked up *on its own*. You can
  always start one yourself — both forcing paths take any unsent status.
- **Nothing *reaches GitHub* except by a deliberate human act — the cockpit's
  Send button or `cerber send` — or by opt-in auto-send.** That is the one hard
  rule of the product. The status field is held to it as well:
  `PATCH /api/reviews/:key` takes only `reviewed` and `skipped`, the two that
  are your decision, so nothing but the send path can write `sent`.
- **Neither will send a draft a run is rewriting.** The cockpit answers `409`,
  refusing on the artifact's status *and* on this process's own claim;
  `cerber send` prints the reason and exits non-zero, and goes on the status
  alone, which is all another terminal can see.

---

## 4. When does the AI run?

`reviewPr` (`src/runner/review.ts`) is the single entry point. Before it spends
a token it checks the artifact already on disk:

1. `force`? → run. (The cockpit's **re-review** button always forces;
   `cerber review --force` too.)
2. Status in `SETTLED_BY_YOU` (`reviewed`, `skipped`)? → **skip**, log
   "use --force". *This is why marking a PR reviewed survives a push.*
3. Status in `HEAD_SENSITIVE` (`ready`, `sent`) **and** the head the last run
   *read* is still the PR's head? → **skip** as up to date. (Which sha that is,
   and why it is not `pr.headSha`, is the paragraph below.)
4. Otherwise → run.

Steps 2 and 3 write a note to the review's history (§6) saying so — a poll that
looks at a row and deliberately does nothing is otherwise indistinguishable
from one that never looked, which is the hardest thing about it to debug.

So a `ready` **or `sent`** artifact on a PR that gets a new commit is meant to
be re-drafted by the next poll: `HEAD_SENSITIVE` only skips while the head is
*unchanged*. For a sent one that is the point — submitting cleared GitHub's
request, so a fresh one only ever arrives because someone asked for another
look (`review.test.ts`). Both need the PR to still be in the awaiting search:
`reviewAll(refs)` is fed the search results, so a PR you pasted by hand and
that GitHub isn't asking you about is never auto re-reviewed.

**Opening a review does not count as reviewing it.** The comparison is against
`run.reviewedSha` — the head this artifact's last run actually *read*, written
when it finished — and not against `pr.headSha`, which the refresh moves
forward every time you open a draft so its comments stay anchored to current
code. Those two used to be the same field, so merely looking at a draft after a
push convinced the guard the draft was current and the poll never re-reviewed
that PR again. An artifact written before `reviewedSha` existed has none, and
falls back to the old comparison.

**A re-review replaces the whole draft, including comments you wrote.** They
are dropped when the run starts and they do not come back — not on success, not
if the run fails. This is a decision rather than an oversight, and it is stated
here rather than left to be discovered: if you have written comments you want
to keep, send the review or copy them out before pressing re-review.

What a re-review does *not* touch are the decisions you have made
(`mergeRunResult`, `src/core/refresh.ts`). The run's result is folded onto
whatever the artifact says now rather than written over it, so a send stands, a
`reviewed` or `skipped` you set while the run was going stands — with the fresh
draft underneath it, which is what the row shows if you change your mind — and
the chat transcript is kept. Only the draft itself is the run's to replace.

### Re-review vs refresh — different things

| | **refresh** (`POST /api/reviews/:key/refresh`) | **re-review** (`POST /api/reviews/:key/rerun`) |
| --- | --- | --- |
| Costs | a PR fetch, plus a diff fetch only if the head moved | a full AI run |
| Changes | `diff`, `pr`, comment line anchors | everything the AI writes |
| Runs when | **you open a review** (automatic, `web/src/Detail.tsx`) | you press the button |
| Does nothing on | a `sent` **record**, `status: running`, or an unchanged head — a `200` with `changed: false`, not an error | a `sent` **record**, or a run already in flight — these *are* errors (`409`) |

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
| **awaiting** | `live` where status is `awaiting` or `running` | found but not drafted yet, or a run is in flight right now |
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

Only a `ready`, unsent draft can be filed. The first two reasons additionally
require that the draft wasn't your own later request (`filedByYourAct`); the
third has a stricter guard of its own (`filedByWithdrawnRequest`, which demands
`run.trigger === "daemon"`). Checked in order of how much each says (the guards
in `src/server/daemon.ts`; the `FiledReason` type itself in
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

The two cases that leave a row alone — someone has answered you, and GitHub
still lists you as a requested reviewer despite the search — write a note to
the review's history (§6) rather than passing in silence. The second is the one
fact nobody can reconstruct afterwards: what the awaiting search said at that
minute, and that the PR itself disagreed with it.

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
   existed, and `null` on older artifacts. It is what lets filing spare a
   second opinion you deliberately asked for — and the two guards read a `null`
   in opposite directions, deliberately. `filedByYourAct` still files a legacy
   draft, because it has GitHub's own timestamp to stand on;
   `filedByWithdrawnRequest` requires `daemon` outright, because a withdrawn
   request is its only evidence and a `null` cannot be told from a draft you
   asked for.
3. **On success** — `ready`, plus `summary`, `chapters`, `comments`, `verdict`,
   `run.costUsd`, and `run.reviewedSha`, the head this run actually read, which
   is what §4's freshness guard compares against. Also `run.sessionId` — the
   Claude session chat turns resume, recorded **only for a source-backed run**
   (`source ? review.sessionId : null`), since there is no checkout for a
   `--no-source` turn to resume into.
4. **On failure** — `run.error`, and `failed` *unless the status is yours*: a
   `sent`, `reviewed` or `skipped` that landed while the run worked stands, and
   the error is recorded beside it (`userOwnsStatus`). Only for failures *after*
   step 1, at that. `reviewPr` fetches the diff and resolves trust and the checkout
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

### The history: the record one `updatedAt` cannot keep

An artifact carries a single `updatedAt`, so every write erases the answer to
"when did this become `skipped`, and did anything ask for it again afterwards?".
`history` is the answer that survives — an append-only list on the artifact,
oldest first, read in the cockpit's **history** card and with `cerber history
<pr>`.

It is written by `saveArtifact` itself (`src/core/state.ts`), never by its
callers: several write paths hand over an artifact built minutes earlier, and a
log any of them had to remember to carry would be lost by the first that
didn't. So a history handed in is ignored — what is on disk is the only copy —
and a new write path is recorded without knowing history exists.

Which is why every save re-reads the file first, even when the caller has just
read it. Two writers share these files (§1), so a caller's copy can be out of
date by the time it writes, and appending to *that* would drop whatever the
other one recorded in between. The rest of the artifact is lost in that race
either way; the history need not be.

Three things go in, and two deliberately don't (`src/core/history.ts`):

- **What changed**, from a watchlist: status, head sha, PR state and draftness,
  a run starting/finishing/failing and what it could read, the verdict,
  comment churn, send, filing, refresh. A watchlist rather than a deep diff,
  or a running turn's narration — rewritten every couple of seconds — would
  bury everything else.
- **Who did it**: `daemon`, `cockpit`, `cli`, `runner`, with the request, poll
  or run that caused it. Set once at each entry point (`withWriter`), ambient
  from there down.
- **What the poll decided *not* to do** — the notes in §4 and §5 below, written
  with `noteHistory`. A decision re-taken every poll is recorded once, and a
  note does not touch `updatedAt`: it is not a change to the review and must
  not reorder the queue.
- **Not** GitHub's timeline. Pushes, requests and reviews are GitHub's own
  record and `gh` can be asked for them again; the exception is what the
  awaiting *search* said at a given minute, which cannot be asked for later.
- **Not** the chat, which already carries its own turns, timestamps and edits.

The most recent 500 entries are kept, with a marker where older ones were
dropped. Deleting a stub deletes its history with it; nothing else removes one.

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

CLI flags cap the config, never raise it — `--no-poll`, `--no-auto-review`,
`--no-trust`. `--no-source` is the exception: it sets the default a run starts
from, and the re-review endpoint's `?source=` overrides it either way, so the
cockpit's button can ask for a source-backed run on a server started without
one.

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

**"Why did this PR come back?"** — The poll re-drafted it, which needs polling
and auto-review both on and the PR still in the awaiting search. Given that:
its status was `awaiting` or `failed`, which are retried with no push involved
at all; or the author pushed and it was `ready` or `sent`, both head-sensitive
— though a `sent` row also needs someone to have asked you again. Whether you
have opened the draft since the push makes no difference: the guard compares
against the head the run *read*, not the one the artifact mentions. Only
`reviewed` and `skipped` never come back under any of it.

**"Why won't it re-review?"** — Both causes are the freshness guard in §4, so
they only bind the callers that obey it (the poll, plain `cerber review`):
status is `reviewed`/`skipped`, or the head the last run *read* is still the
PR's head on a `ready`/`sent` row. `cerber review --force` forces past both. The cockpit's re-review button
forces too, but refuses a `sent` artifact outright — that record is not
rewritten from the UI, though the poll will still re-draft it once the head
moves.

**"When did I skip this — and did they ask again after?"** — `cerber history
<pr>`, or the **history** card at the foot of the review. It carries the status
change with its timestamp and who made it, every push it saw, and the poll's
own notes for the times it looked at the row and deliberately left it alone.
Empty on reviews that predate it being kept.

**"Why does it say reviewed when I never touched it?"** — The poll filed it;
`filed.reason` says which of the three cases. The draft is untouched and still
sendable.

**"Where did my edited comment go after a re-review?"** — Gone, deliberately: a
re-review regenerates the draft and your comments go with it, whether the run
succeeded or failed. Send or copy anything you want to keep first. What does
survive is the chat, and any decision you had already made — a send, a
`reviewed`, a `skipped`.
