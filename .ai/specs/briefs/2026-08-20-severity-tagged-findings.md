# Severity-tagged review findings (blocker/minor/nit) so the blocking cut is legible per-comment

- Date: 2026-08-20
- Category: feature
- Priority signal: medium — the sole maintainer reads cerber drafts daily and cannot tell which findings drive a request_changes verdict without re-deriving it
- Risk signal: low — additive optional schema field, no version bump, advisory verdict coupling; the riskiest part (prompt change) is gated on evidence
- Routing: Next: om-auto-create-pr "Add severity-tagged review findings (blocker/minor/nit) to cerber — brief: .ai/specs/briefs/2026-08-20-severity-tagged-findings.md"

## Problem

When reading a drafted cerber review, nothing links the verdict to the comments that caused it: `verdict.recommendation` floats free of `comments[]` (`src/core/artifact.ts` — comments carry only `path/line/body/chapterId`). The reviewer wants each finding tagged with its merge impact, the way the Open Mercato team's reviews are, so "only blockers stop approval" is legible at a glance in the cockpit and on GitHub. Evidence: OM's `om-code-review` skill (open-mercato/skills) severity-ranks every finding and derives the verdict from the worst one; a real OM review (open-mercato/open-mercato PR #5402, review 4978084371) confirmed the format works, and also confirmed the trap to avoid — its C/H/M/L labels force the rule to be restated inside every review ("this repo requests changes on Medium").

## Agreed direction

Add an **optional** `severity` enum — `blocker | minor | nit` — to the comment schema, thread it through the prompt, the chat-revision ops, the cockpit, Send, and the autosend gate. The taxonomy was chosen so every word carries its own merge semantics with no rule to restate: **blocker** = would not approve with this in (the only tier that blocks), **minor** = should fix, author's call, won't chase it, **nit** = taste/naming/polish. **Absent severity is meaningful, not legacy**: a question, note, or praise is not a finding and carries no tier by construction (it also never trips the autosend guard or the count line).

Explicitly rejected, and why:

- **Build nothing / prose-only** (verdict `reasoning` names the blocking comments): doesn't make severity legible per-comment in the cockpit's chapter view; the reader still re-derives the cut.
- **Prompt-only text prefixes** (no schema field): cockpit can't badge/sort/count, autosend can't use it, chat-revision turns drift it — a half-working default, which this repo's principles forbid.
- **Binary `blocking` flag**: solves the verdict question but collapses the non-blocking tail; the minor/nit split carries real signal and is where drop-rate calibration data (`aiCommentsDropped`, `editedByUser`) gets its gradient. A pure binary also pressures the model toward "everything blocks" because there's no cheap way to say "worth saying, barely".
- **4-tier ladders** — both `blocker/major/minor/nit` (OM canonical) and `critical/high/medium/low` (OM repo variant): with two tiers above the cut, the reader must learn which non-"blocker" tiers also block. OM's blocker-vs-major line is a waiver distinction ("major blocks unless the maintainer accepts the risk") that is thin in cerber — there is no team to negotiate a waiver with; the human at the cockpit is the waiver mechanism every time. C/H/M/L additionally is scanner/CVSS vocabulary, not review vocabulary, and collides with CVSS wording when a review finds a real security issue.
- **Derived/enforced verdict** (code computes recommendation from worst live severity; dropping the last blocker auto-softens to approve): rejected as propose/accept machinery — a human vouches at Send, and silent verdict flips undermine that.
- **Auto-rewriting the summary after the user edits/drops comments**: an AI run takes minutes and a self-rewriting summary mid-walkthrough is surprising. The existing chat path is the right tool; see the one-click re-true action below.
- **Emoji-only Send prefixes**: under the widespread (Google-documented) convention, an unprefixed comment reads as "the reviewer wants this changed" — the word must be there; `nit:` is the most widely recognized token in code review and needs no legend.

## Resolved unknowns

| Question | Answer (from the conversation) |
|----------|--------------------------------|
| Taxonomy | `blocker \| minor \| nit`, optional. Absent = not a finding (question/note/praise), not "unknown severity". |
| Blocking cut | `blocker` only. Minor and nit never block; absent never blocks. |
| Verdict coupling | Advisory. The prompt states the rule — the verdict must follow from the worst live finding, named in `verdict.reasoning` — but no code derives or enforces the recommendation from severities. |
| Schema versioning | Optional field on `CommentSchema`; **no `schemaVersion` bump**. Old artifacts, hand-edited files, and user-authored comments legitimately lack severity and must keep parsing and rendering everywhere. |
| User-authored comments | No severity by default and no forced choice in the cockpit's comment editor. |
| "Grade as if true" prompt rule | Yes — severity is graded assuming the finding is real; if the model doesn't believe it, it doesn't write it (or writes it as a question, which carries no severity by construction). Without this rule severity silently degrades into a second confidence scale and "only blockers block" becomes "only things the model felt sure about block". Confidence stays verdict-level only. |
| Chat revisions | `comment-add` carries severity; `comment-edit` may re-grade an existing comment's severity. Both in the revision JSON schema in `src/runner/prompt.ts`. |
| Cockpit rendering | Chapter grouping stays (it's the story-of-the-PR spine). Severity is a badge on each comment card plus a count line next to the verdict ("1 blocker, 2 nits"). |
| Verdict/findings inconsistency | Passive hint when the verdict no longer follows from live findings (request_changes with no live blocker, or approve with one), carrying a one-click "re-true the review" action that fires a pre-filled chat turn ("some findings were dropped/edited — update the summary and verdict to match what remains") through the existing chat path. No auto-run, no new subsystem. |
| Send rendering | Every graded comment gets a word prefix — `**blocker:** …`, `**minor:** …`, `**nit:** …` — including comments folded into the review body ("additional notes" path in `src/core/send.ts`). Ungraded comments render bare. Word, not emoji-only. |
| Autosend | New guard: an approve verdict with any **live** blocker comment ⇒ ineligible for auto-send, with the reason logged to autosend.ndjson (alongside the existing recommendation+confidence gate in `src/core/autosend.ts`). |
| Severity survival | Severity must persist through every path that rewrites or carries comments: `carryOverComments` on re-review, re-anchoring (`src/core/anchor.ts` / `refresh.ts`), `mergeConcurrentEdits` (`src/core/revise.ts`), and chat-turn revisions. Each path gets a test; losing severity on the first re-review is the half-working-default failure mode. |
| Evidence gate for the prompt change | Per the repo rule that `src/runner/prompt.ts` changes come from evidence, not taste: before landing, run the amended prompt against 3–5 already-reviewed PRs and compare the severity labels to the user's actual keep/drop/verdict decisions on those reviews. Inconsistent blocker/minor grading at the cut is a stop-and-revise signal. |

## Non-goals

- No 4-tier ladder, no major tier, no C/H/M/L — see rejections.
- No code-derived or auto-softened verdict; no enforcement of the severity→verdict rule outside the prompt.
- No auto-rewrite of summary/verdict on comment edits (the one-click chat action is the ceiling).
- No forced severity on user-authored comments; no severity picker friction in the editor (an optional control is fine).
- No re-grouping of the cockpit by severity — chapters stay the spine.
- No GitHub-side legend or rule restating; the words carry the semantics.

## Affected areas (if known)

- `src/core/artifact.ts` — optional `severity` on `CommentSchema` (no version bump)
- `src/runner/prompt.ts` — review-prompt severity table + "grade as if true" + verdict rule; chat-prompt revision schema (`comment-add`, `comment-edit`); `renderReview` showing severity so chat turns see it
- `src/core/revise.ts` — apply severity from revisions; `mergeConcurrentEdits` preserves it
- `src/core/anchor.ts` / `src/core/refresh.ts` — severity carried through re-anchoring (verify; likely free if comments are copied whole)
- `src/core/send.ts` — word prefixes on inline and folded comments
- `src/core/autosend.ts` — live-blocker guard
- `web/src/Detail.tsx` (+ `styles.css`, `types.ts`) — badge, count line, inconsistency hint + one-click re-true chat action
- Existing state/review tests beside each of the above (`*.test.ts`)
