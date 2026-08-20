# Run: README with screenshots

- Date: 2026-08-20
- Slug: `readme-screenshots`
- Branch: `feat/readme-screenshots`
- Engine: om-auto-create-pr (steps: 5, --loop: no)

## Goal

The README describes a visual product — a review cockpit — in prose alone.
Add real screenshots and restructure the document so a first-time reader sees
the product before the fifth paragraph, without losing the README's voice.

## Scope

- `README.md` — badges, screenshots, subheads, roadmap compression.
- `docs/*.png` — four cockpit screenshots, committed to the repo but excluded
  from the npm package (`files` allowlist already omits `docs/`).

### Non-goals

- No cockpit or CLI changes (notably: no dark theme — screenshots are light
  because that is all the cockpit has).
- No packaging changes; `files` in `package.json` stays as-is.
- No rewrite of the README's long-form sections beyond subheads and the
  roadmap → Status compression; the voice and facts stay.

## Implementation plan

### Phase 1: Evidence

Screenshots must show real reviews without leaking client repos, so the demo
data is cerber reviewing its own public PRs (#20–22) in a throwaway
`CERBER_HOME`, served on a spare port, captured with Playwright. The chat
screenshot is a genuine turn: the reviewer was challenged on a comment,
re-checked the code, and dropped it.

### Phase 2: README

Hero queue screenshot after the intro with a provenance note; npm/license
badges; walkthrough + inline-comment screenshots in "What a review looks
like"; chat screenshot in "Arguing with the review"; subheads over the three
dense inbox paragraphs; all-shipped phase checklist compressed into a Status
paragraph.

## Risks

- Screenshots go stale as the cockpit evolves — acceptable; they are dated by
  the PRs they show and cheap to recapture (the procedure is in this plan).
- Relative image paths must resolve on both GitHub and npmjs — npm rewrites
  them via the `repository` field, which is set.

## Progress

PR: #25

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Evidence

- [x] 1.1 Generate demo review artifacts of cerber's own PRs (#20–22) in a throwaway CERBER_HOME — ce92b78
- [x] 1.2 Capture queue, walkthrough, inline-comment and chat screenshots into docs/ — ce92b78

### Phase 2: README

- [x] 2.1 Add badges, hero screenshot and provenance note to the intro — ce92b78
- [x] 2.2 Embed remaining screenshots, add inbox subheads, compress roadmap into Status — ce92b78

### Phase 3: Gate

- [x] 3.1 Run the full validation gate (typecheck, test, build) — green: typecheck ✓, 353 tests ✓, build ✓

### Phase 4: Review autofix

- [x] 4.1 Recapture all four screenshots on the 0.18 cockpit (Detail view gained a chat column and rail entries in #24)
- [x] 4.2 Fix the queue paragraphs still describing pre-#22 drawers (found by cerber's own review of #22)
