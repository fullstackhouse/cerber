# Execution plan — chat with the reviewer about a drafted review

- Date: 2026-08-19
- Slug: `review-chat`
- Branch: `jtomaszewski/chat-with-review-agent`
- Base: `main`
- Source doc: `.ai/specs/briefs/2026-08-19-review-chat.md`
- Engine: om-auto-create-pr (steps: 17, --loop: no)

## Goal

Let the user argue with a drafted review in the cockpit and have the reviewer revise its own
draft in place, before Send.

## Scope

Between "the AI drafted a review" and "Send", the only levers today are hand-editing each
comment or `rerun` — a full re-review with no way to say *what* was wrong. This adds a
multi-turn chat attached to a review artifact, in which turns resume the original reviewer
(so it still holds everything it read) and the agent writes its revisions directly into the
artifact.

Shape, fixed by the brief:

- One thread per review; a "discuss this" affordance on the summary, each chapter and each
  comment drops a reference into the next message.
- Turns resume the reviewer's `claude -p` session via a captured `session_id`.
- The agent writes the artifact directly — no accept step. The turn shows what it changed.
- One pre-chat snapshot is the escape hatch; there is no per-turn undo.
- Comments the user wrote or edited (`editedByUser`) are not rewritten without asking.
- The transcript never reaches GitHub. Send still builds from summary/comments/verdict and
  stays a human click.

## Non-goals

- A steer field on `rerun`
- Per-comment or per-chapter threads
- A propose/accept or diff-review UI
- Per-turn undo with before-snapshots
- Streaming turn output (poll, like `rerun` does)
- Any new GitHub write path
- The `prompt.ts` anti-parroting rule — its own PR, per the brief

## Risks

- **Session resume into an evicted checkout.** `~/.cerber/src` is LRU-8 and evicts fast;
  Claude sessions are keyed by cwd. Resuming into a deleted directory keeps the transcript
  but breaks `Read`/`Grep`, so the agent would cite code it can no longer open. Phase 4
  exists to make that state impossible or, failing that, explicit to the model.
- **One step from the only GitHub write.** The chat agent writes the artifact Send posts.
  Every isolation guarantee a review run carries (unauthenticated env, untrusted checkout,
  no Edit/Write) must hold identically for a chat turn.
- **Clobbering human words.** `carryOverComments` exists so a re-review never discards the
  user's work. A chat turn is a second way to lose it.
- **Resume may not be reproducible across CLI versions.** If `--resume` proves unreliable,
  the fallback is a rebuilt prompt carrying the review plus the transcript; the runner is
  written so that swap is local.

## Implementation Plan

### Phase 1 — Session capture and resume plumbing

Nothing else works until a turn can re-enter the reviewer's session.

- 1.1 `runClaude` returns `sessionId` from the JSON wrapper; `buildClaudeArgs` grows a
  `resumeSessionId` option emitting `--resume`.
- 1.2 `RunInfo` gains `sessionId`; `review.ts` persists what the run returned.
- 1.3 Tests: arg construction with and without resume, wrapper parsing, absent `session_id`.

### Phase 2 — Chat schema and revision core

- 2.1 `ChatTurnSchema` (role, text, revisions, at, costUsd), `chat: ChatTurn[]` and
  `preChatSnapshot` on the artifact, plus the `AiChatTurnSchema` the model must return.
- 2.2 `applyRevisions(artifact, revisions)` — a pure function mapping validated revisions
  (rewrite summary, edit/drop/add a comment, rewrite a chapter, change the verdict) onto an
  artifact, refusing to touch `editedByUser` comments.
- 2.3 Tests for every revision kind, the `editedByUser` refusal, and unknown-target handling.

### Phase 3 — The chat prompt and turn runner

- 3.1 `buildChatPrompt` — the current review, the transcript, what the user pointed at, which
  comments are the user's, whether the source is readable, and the same untrusted-checkout
  and read-only clauses a review run carries.
- 3.2 `runChatTurn` — claims `runner/inflight`, resumes or rebuilds, validates with zod and
  retries once, applies revisions, appends the turn.
- 3.3 Tests: prompt contents under each condition, inflight claim, bad-JSON retry.

### Phase 4 — Keeping the source readable

- 4.1 A chat pins its checkout: `evictOldCheckouts` skips a pinned one, and opening a chat
  re-clones when the checkout is already gone. When neither is possible the prompt says so
  plainly instead of letting the model assume it can read.
- 4.2 Tests: pinned checkouts survive eviction, re-clone on miss, degraded flag on failure.

### Phase 5 — Server endpoints

- 5.1 `POST /api/reviews/:key/chat` (one turn), `POST /api/reviews/:key/chat/reset` (restore
  the pre-chat snapshot); both refuse once `sent`.
- 5.2 Tests for both, including the sent-review refusal and the running-review conflict.

### Phase 6 — The cockpit

- 6.1 Chat panel in `Detail.tsx` plus the `api.ts` client, polling like `rerun`.
- 6.2 "Discuss this" on the summary, `ChapterSection` and `CommentCard`.
- 6.3 Revision markers rendered in the transcript, and the reset control.

### Phase 7 — Docs

- 7.1 README and CLAUDE.md architecture note.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Session capture and resume plumbing

- [x] 1.1 runClaude returns sessionId; buildClaudeArgs emits --resume — c54ebe2
- [x] 1.2 RunInfo.sessionId persisted by review.ts — c54ebe2
- [x] 1.3 Tests for arg construction and wrapper parsing — c54ebe2

### Phase 2: Chat schema and revision core

- [ ] 2.1 ChatTurn schema, chat[] and preChatSnapshot on the artifact
- [ ] 2.2 applyRevisions pure function
- [ ] 2.3 Tests for every revision kind and the editedByUser refusal

### Phase 3: The chat prompt and turn runner

- [ ] 3.1 buildChatPrompt
- [ ] 3.2 runChatTurn with inflight claim and retry
- [ ] 3.3 Tests for prompt contents, claim, and retry

### Phase 4: Keeping the source readable

- [ ] 4.1 Pin the checkout for the life of a chat; re-clone or degrade loudly
- [ ] 4.2 Tests for pinning, re-clone, and the degraded flag

### Phase 5: Server endpoints

- [ ] 5.1 POST chat and POST chat/reset
- [ ] 5.2 Endpoint tests including the sent-review refusal

### Phase 6: The cockpit

- [ ] 6.1 Chat panel and api client
- [ ] 6.2 Discuss-this on summary, chapter and comment
- [ ] 6.3 Revision markers and the reset control

### Phase 7: Docs

- [ ] 7.1 README and CLAUDE.md architecture note
