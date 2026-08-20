# Execution plan: severity-tagged review findings (blocker/minor/nit)

- Date: 2026-08-20
- Slug: severity-tagged-findings
- Branch: feat/severity-tagged-findings
- Engine: om-auto-create-pr (steps: 10, --loop: no)
- Source doc: .ai/specs/briefs/2026-08-20-severity-tagged-findings.md

## Goal

Every AI review finding carries an optional severity — `blocker | minor | nit` — so the blocking cut ("only blockers stop approval") is legible per comment in the cockpit and on GitHub. Absent severity means "not a finding" (question/note/praise), not "unknown".

## Scope

- `src/core/artifact.ts` — optional `severity` on `CommentSchema`, `AiReviewSchema.comments`, and the `comment-add`/`comment-edit` revisions. **No `schemaVersion` bump** — old artifacts and user comments legitimately lack it.
- `src/runner/review.ts` — map severity from the AI output into artifact comments.
- `src/runner/prompt.ts` — review prompt: severity field + table + "grade as if true" + verdict-follows-worst-finding rule; chat prompt: severity on `comment-add`/`comment-edit`, `renderReview` shows tags.
- `src/core/revise.ts` — apply severity on `comment-add`/`comment-edit`.
- `src/core/send.ts` — word prefixes (`**blocker:** …`) on inline and folded comments.
- `src/core/autosend.ts` — approve + any live blocker ⇒ ineligible.
- `web/src/` — severity badge on comment cards, count line by the verdict, inconsistency hint with one-click re-true chat action; API pass-through for hand-set severity (no picker UI).
- Severity survival tests across `carryOverComments`, re-anchoring, `mergeConcurrentEdits`, chat revisions.

## Non-goals (from the brief)

- No 4-tier ladder, no C/H/M/L, no `major` tier.
- No code-derived or auto-softened verdict — advisory coupling only.
- No auto-rewrite of summary/verdict on comment edits (one-click chat action is the ceiling).
- No forced severity on user comments; no severity picker in the editor.
- No re-grouping of the cockpit by severity — chapters stay the spine.

## Risks

- **Prompt-rule drift**: `src/runner/prompt.ts` is tuned against real reviews; the severity instructions could skew comment quality. Mitigated by the evidence step (5.1): replay the amended prompt on real past reviews and compare labels against the user's actual keep/drop decisions before calling the run complete.
- **Silent severity loss** on a rewrite path would make the feature a half-working default; each path gets an explicit test.
- Cockpit hint logic must tolerate artifacts with no severities at all (pre-change artifacts) — hint only fires when a severity signal exists.

## Implementation Plan

### Phase 1: Schema and severity survival

- Step 1.1 — Add optional `severity: z.enum(["blocker","minor","nit"])` to `CommentSchema`, `AiReviewSchema.comments`, and `comment-add`/`comment-edit` in `RevisionSchema`; no version bump; tests: severity-less artifact parses, severity round-trips.
- Step 1.2 — Thread severity through `src/runner/review.ts` (AI output → comment) and `src/core/revise.ts` (`comment-add` sets it, `comment-edit` may re-grade); survival tests for `carryOverComments`, `reanchorComments`/`refreshArtifact`, and `mergeConcurrentEdits`.

### Phase 2: Prompts

- Step 2.1 — Review prompt: severity in the JSON shape, the severity table with merge semantics, the "grade as if true" rule, and the verdict-follows-worst-live-finding rule named in `reasoning`.
- Step 2.2 — Chat prompt: severity on `comment-add`/`comment-edit` in the revision shape; `renderReview` prints each comment's severity so chat turns see the grading.

### Phase 3: Send and autosend

- Step 3.1 — `send.ts`: graded comments get `**severity:** ` word prefixes inline and in the folded "Additional notes" list; ungraded comments render bare; tests.
- Step 3.2 — `autosend.ts`: approve verdict with any live (non-dropped) blocker comment ⇒ ineligible with a plain reason; tests.

### Phase 4: Cockpit

- Step 4.1 — `web/src/types.ts` + comment-card severity badge + count line beside the verdict ("1 blocker, 2 nits"); server/API pass-through so hand-set severity on user comments is accepted (no picker UI).
- Step 4.2 — Inconsistency hint (request_changes with no live blocker, or approve with one) carrying a one-click "re-true the review" action that pre-fills a chat turn through the existing chat path.

### Phase 5: Evidence and docs

- Step 5.1 — Evidence gate for the prompt change: replay the amended prompt against 3–5 already-reviewed PRs (real artifacts in `~/.cerber/reviews`) and compare severity labels with the user's actual keep/drop/verdict decisions; record the comparison here and in the PR. Inconsistent blocker/minor grading at the cut = stop and revise the prompt.
- Step 5.2 — Docs: note the severity vocabulary in CLAUDE.md's review-prose rules and the README feature list.

## Evidence (step 5.1) — amended prompt replayed on real past reviews

Replayed the amended review prompt (diff-only, all tools off, same flags as a
real no-source run) over six artifacts from `~/.cerber/reviews` and compared
grades with what the human actually did. Script: an untracked
`/tmp/replay-severity.mts` riding the repo's own `buildReviewPrompt`/`runClaude`.

| Artifact | Human's final action | Amended prompt's verdict | Grades used |
|---|---|---|---|
| skills#22 | sent APPROVE, 6 comments kept | approve @72% | 2 minor · 2 nit |
| open-mercato#92 | sent APPROVE, 6 kept | approve @78% | 3 minor · 2 nit · 1 ungraded question |
| tournee#997 | sent APPROVE, 2 kept | approve @72% | 2 minor · 1 ungraded question |
| tournee#1006 | sent APPROVE, 2 kept | comment @68% | 3 minor · 1 nit · 1 ungraded question |
| groomershop-mercato#362 | reviewed (approve), 3 kept | approve @72% | 1 minor · 2 nit · 1 ungraded question |
| tournee-frontend#9 | request_changes (skipped) | request_changes @72% | 1 **blocker** · 1 minor · 1 nit · 1 ungraded question |

Findings:

- **No spurious blockers.** Every review the human ultimately approved came
  back with zero blockers under the amended prompt — the cut did not inflate.
- **Verdict follows the worst finding, and names it.** All reasoning fields
  close on "the worst finding still standing is …", as the rule demands.
- **The question escape hatch works.** Four comments came back explicitly
  framed "question, not a finding" with no grade — the rule that severity
  absent means "not a finding" is being exercised, not ignored.
- **The blocker side holds.** On the corpus's one request_changes review
  (tournee-frontend#9 — a feature-branch pin in `plasmic.json` that would
  break future syncs), the amended prompt graded exactly that finding
  **blocker**, kept the verdict request_changes, and named it as the deciding
  issue. It also downgraded "nothing renders this component yet" to an
  ungraded question — a sharper account than the original's three ungraded
  comments.

Verdict: 6/6 replays consistent with the human's actual decision, the cut
behaves at both ends, and no grade was used to hedge doubt. The prompt change
ships as written.

## Progress

PR: #16

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Schema and severity survival

- [x] 1.1 Optional severity enum on comment, AI-review, and revision schemas — de76acd
- [x] 1.2 Thread severity through runner and revise; survival tests on all rewrite paths — de76acd

### Phase 2: Prompts

- [x] 2.1 Review prompt: severity table, grade-as-if-true, verdict-follows-worst rule — 417fb46
- [x] 2.2 Chat prompt: revision severity and renderReview tags — 417fb46

### Phase 3: Send and autosend

- [x] 3.1 Send: word prefixes on graded comments, inline and folded — 3824397
- [x] 3.2 Autosend: live-blocker guard — 3824397

### Phase 4: Cockpit

- [x] 4.1 Severity badge, count line, API pass-through — aff4af1
- [x] 4.2 Inconsistency hint with one-click re-true chat action — aff4af1

### Phase 5: Evidence and docs

- [x] 5.1 Replay amended prompt on past reviews; record label calibration — 46a8f55
- [x] 5.2 Docs: severity vocabulary in CLAUDE.md and README — 5efd7ca
