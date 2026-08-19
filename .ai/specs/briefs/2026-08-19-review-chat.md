# Talk to the reviewer about a drafted review, and revise it, before Send

- Date: 2026-08-19
- Category: feature
- Priority signal: medium — the review-to-Send gap is where the user loses trust in a draft they can't argue with; not blocking any release
- Risk signal: medium — the chat agent writes the artifact that Send posts, so it sits one step from the only GitHub write path
- Routing: `Next: om-auto-write-spec "Conversational revision of a drafted cerber review before Send — brief: .ai/specs/briefs/2026-08-19-review-chat.md"`

## Problem

Between "the AI drafted a review" and "Send", the only levers are hand-editing each comment or `rerun` — a full re-review with no way to say *what* was wrong with the last one. So when a draft is so-so, the user either rewrites it by hand or rolls the dice again.

The concrete case: on `fullstackhouse/open-mercato#93`, the summary reads "…so the one-line summaries used in pickers and table cells stay purely postal." The PR body reads "…joins them with `", "` into the one-line summaries used in pickers and table cells." A verbatim borrow, restated as verified fact. `src/runner/prompt.ts:83` forbids imitating the description's *style*; nothing forbids adopting its *claims*. The user wanted to tell the reviewer that and get a corrected review — and there is no way to.

## Agreed direction

A multi-turn chat attached to a review artifact, in which the reviewer can be argued with and revises its own draft in place.

- **One thread per review**, not per-comment threads. A "discuss this" affordance on the summary, each chapter, and each comment drops a reference into the next message, so the agent knows what is being pointed at without a keyed schema.
- **Turns resume the original reviewer.** `claude -p` already returns `session_id` in its JSON wrapper; `src/runner/claude.ts:150` discards it. Capture it, store it on `run`, and resume with `--resume` so the agent still holds everything it read. This is the whole reason chat beats a one-shot steer field: the agent can answer "I did verify that — here's the test", not re-derive an opinion from the diff.
- **The agent writes the artifact directly.** No accept step. A turn returns its reply plus the revisions it made, shown inline in the transcript ("✎ rewrote the summary", "✎ dropped the comment on line 250").
- **The prompt gets fixed too, separately.** A rule that the author's claims are hypotheses to check rather than facts to restate, and that the summary reports what the reviewer verified. Chat is for disputes a prompt cannot anticipate; it is not the fix for a defect that recurs on every review. Small, independent PR — must not wait behind this subsystem.

Rejected:

- **Build nothing / hand-edit forever.** Loses because hand-editing cannot ask the reviewer *why* it said something, and because a rerun that throws away a good draft to maybe get another one is not a revision mechanism.
- **A steer field on `rerun`** ("what's wrong with this review", fed into the prompt alongside the previous output). Cheap — reuses the endpoint, `inflight`, and `carryOverComments` — but one-shot and mute. Rejected explicitly: the user wants the reviewer to answer back.
- **Propose-then-accept.** Rejected on the user's own point: plan mode already produces that behaviour inside a conversation when you want it, so a permanent accept-button is friction on a change you explicitly asked for. It also contradicts "don't re-ask for a confirmation the user just gave"; Send remains the place a human vouches for what reaches GitHub.
- **An undo button per turn.** Rejected as a scope trap — per-turn before-snapshots are propose/accept machinery applied eagerly. The conversation is the undo.
- **Chatting outside the cockpit** (the existing `fsh:cerber` skill plus the PATCH endpoints). Zero product work, but leaves the capability invisible to anyone who opens cerber and expects the draft to be arguable.

## Resolved unknowns

| Question | Answer (from the conversation) |
|----------|--------------------------------|
| Conversation or one-shot redirection? | Conversation. The agent must be able to push back and be argued with. |
| Where does a chat attach? | One thread per review, with a pointer affordance from summary / chapter / comment. Not per-target threads. |
| How does a turn get context? | Resume the reviewer's session via a captured `session_id`. |
| What if the checkout is gone? | `~/.cerber/src` is LRU-8 and evicts fast (`#93`'s was already gone mid-conversation). Sessions are keyed by cwd, so resuming into a deleted checkout keeps the transcript but breaks `Read`/`Grep` — the agent would cite code it can no longer open. Opening a chat must pin or re-clone the checkout; if neither works, tell the agent plainly that the source is gone and it is arguing from the transcript and diff alone. |
| Do revisions need acceptance? | No. The agent writes directly; the turn shows what it changed. |
| What is the escape hatch? | One pre-chat snapshot of the artifact — "reset to what the AI first wrote". Not per-turn undo. |
| What protects human-written words? | The agent is told which comments are `editedByUser` and must ask before rewriting them. `carryOverComments` exists precisely so a re-review never discards the user's work; chat must honour the same rule. |
| Does the transcript reach GitHub? | Never. Send still builds its payload from summary / comments / verdict only, and stays an explicit human click. |
| Concurrency | A chat turn claims `runner/inflight` like any other run, so it cannot race the daemon's timer or the cockpit's re-review button. |
| Calibration | Chat-driven changes count as `aiCommentsEdited` / `aiCommentsDropped` like any other edit. The transcript is *better* calibration signal than a silent hand-edit, because it records why the first draft was wrong. |
| Streaming? | No. A turn polls like `rerun` does. |
| Does chat replace the prompt fix? | No — complement. The parroting defect is systemic and gets a separate small PR against `src/runner/prompt.ts`. |

## Non-goals

- A steer field on `rerun`
- Per-comment or per-chapter chat threads
- A propose/accept or diff-review UI for revisions
- Per-turn undo with before-snapshots
- Streaming turn output
- Any new GitHub write path — Send stays the only one, and stays a human click
- The `prompt.ts` anti-parroting rule itself, which ships as its own PR

## Affected areas (if known)

- `src/runner/claude.ts` — capture `session_id` from the JSON wrapper (currently reads only `result`, `total_cost_usd`, `modelUsage`); add `--resume` support to `buildClaudeArgs`
- `src/core/artifact.ts` — chat turn schema, `session_id` on `RunInfo`, the pre-chat snapshot
- `src/core/checkout.ts` — pinning or re-cloning a checkout for the life of a chat; interaction with `evictOldCheckouts`
- `src/runner/inflight.ts` — a chat turn is a claimed run
- `src/runner/prompt.ts` — the chat-turn prompt (distinct from `buildReviewPrompt`), including the untrusted-checkout and read-only clauses a review turn already carries
- `src/server/index.ts` — chat endpoints alongside `rerun` / `refresh` / `send`
- `web/src/Detail.tsx` — the chat panel and the "discuss this" affordance on `CommentCard`, `ChapterSection`, and the summary
