# CLAUDE.md

Cerber: AI code-review cockpit. Claude reviews PRs into local JSON artifacts;
the user walks through them in a local React cockpit. **Hard rule: cerber never
writes to GitHub except (a) an explicit, user-confirmed Send, or (b) daemon
auto-send that the user explicitly enabled with --auto-send — approve-only,
confidence-threshold-gated, every decision logged to autosend.ndjson. No
pending reviews, no comments, no reactions — reviewing is read-only.**

## Product principles

- Fewest clicks wins every tie. A capability ships **on by default with a switch
  to turn it off**, never off with a switch to turn it on — source-backed
  review, the checkout, poll and auto-review all landed that way. The single
  deliberate exception is the GitHub write path: Send stays a human click and
  auto-send stays opt-in.
- Never ship a default that half-works. If the obvious path (open cerber → see
  the PRs awaiting you, drafts already written) needs a manual step to be
  useful, the default is wrong; fix the default instead of documenting the step.
- Don't re-ask for a confirmation the user just gave. A second "are you sure" on
  the action they requested is friction wearing safety's coat.
- Secure by default, and don't offer the insecure shape at all. Where safety and
  convenience genuinely collide, cerber refuses the unsafe option outright
  rather than shipping it behind a warning (see the repo-trust refusal below).
- Review prose is written for someone who has NOT read the diff: plain words,
  effect before mechanism ("a code block was never closed, so everything after
  it displayed as code" — not the parser-level account). It is also shaped
  rather than poured: past two paragraphs a summary breaks into fixed sections
  (🎯 problem, 🔧 fix, 🔍 details, ⚠️ worth knowing — drop the ones with
  nothing to say, and a small PR gets no headings at all), the verdict is
  one lead sentence then bullets, and a comment leads with the finding on its
  own line. The rules live in `src/runner/prompt.ts` and were tuned against
  real reviews — change them from evidence, not taste.
- Findings are graded `blocker | minor | nit`; only a blocker blocks approval,
  and an ungraded comment is not a finding (a question, a note) — never
  "unknown severity". Grades assume the finding is true: doubt lives in the
  verdict's confidence, never in a softened grade. The verdict must follow
  from the worst finding still standing. Severity is advisory — no code
  derives or enforces the verdict from it; the cockpit only points out when
  they disagree. The grade is rendered from the field, never written into the
  body: one badge (`src/core/severity.ts`) opens the comment's own text in the
  cockpit, on GitHub and in the export, so a comment reads the same in all
  three — and the grade survives GitHub, where a chip would not exist.

## Architecture

- `src/core/` — artifact schema (zod, versioned — the contract between AI and
  cockpit), state store (`~/.cerber/reviews/*.json`, plain JSON, no DB),
  gh client (shells out to `gh`, no tokens handled), diff utils,
  re-anchoring (`anchor.ts`/`refresh.ts` — pulls a review onto a newer head by
  matching each comment's line *text*, never a fuzzy guess), review revision
  (`revise.ts` — applies a chat turn's edits, refuses the user's own comments,
  and folds a finished turn onto whatever the artifact says now), source checkouts
  (`checkout.ts` — shallow `refs/pull/N/head` clone per PR under `~/.cerber/src`;
  an LRU cache of 8, evicted as reviews run, reclaimable with `cerber prune`),
  trust rules (`trust.ts` — `@login`, `@org/team`, `@org/*`; people only, no
  way to trust a repo; denials win) and settings
  (`config.ts` — `~/.cerber/config.json`, zod-validated, written by the CLI and
  the cockpit's settings screen)
- `src/runner/` — review prompt + headless `claude -p --output-format
  stream-json` runner (rides the user's login; prompt on stdin; validate output
  with zod, retry once on bad JSON; `progress.ts` turns the run's own events
  into the plain-English lines the cockpit and the logs show while it works). Runs inside the PR checkout with `Read`/`Grep`/`Glob`
  only; `--no-source` reviews the diff alone, with every tool off and an empty cwd.
  `chat.ts` is one turn of a conversation about a finished draft: it resumes the
  review's own session (`run.sessionId`, captured from `claude -p`), re-clones an
  evicted checkout so resume is whole, and revises the artifact directly
- `src/server/` — Hono API + static cockpit serving, plus the inbox loop
  (`daemon.ts`, on by default in `serve`): polls PRs awaiting review into
  `awaiting` stub artifacts, drafts a review for each unless
  `daemon.autoReview` is off, archives merged/closed PRs. Config's `daemon`
  block is re-read every poll, so cockpit toggles apply without a restart.
  Each poll also publishes what it found (`status.awaiting`): the queue filters
  on what you settled locally, which stops matching what GitHub asks you for the
  moment you skip a PR, so the cockpit needs the list to name the awaiting PRs
  its own filters are hiding rather than claim there are none. Each entry also
  carries whose move it is, read from the PR conversation (`classifyReply`) —
  an open request only means you never pressed GitHub's review button, not that
  anyone is blocked on you. Bots are excluded, and a read that fails reports
  `unknown` rather than guessing silence at someone who did reply
- `src/cli/` — commander CLI (`review`, `list`, `serve`)
- `web/` — Vite + React cockpit; imports shared diff utils from `../src/core/diff`.
  `notify.ts` is the arrival bell: it polls the queue from every screen and
  raises a desktop notification for PRs this browser has never seen. Browser
  state, not config — the permission is the browser's, so the switch and the
  announced-keys record live in localStorage beside it

## Conventions

- TypeScript strict, ESM (NodeNext in src/, bundler in web/)
- State files are user-editable: read defensively, write atomically (tmp+rename)
- Zero config: ride existing `gh`/`claude` logins, degrade gracefully
- `pnpm typecheck && pnpm test` must pass before commit
- Conventional commits — they drive the release: every green merge to `main`
  runs semantic-release, so `feat:` ships a minor and `fix:` a patch. Never
  hand-bump `version` or cut a tag/release; CI owns both.

## Don'ts

- Don't add GitHub write calls anywhere except the (future) explicit send path
- Don't add a database or config wizard — plain files, zero config. Settings
  are one JSON file with a zod schema and sane defaults; absent must keep
  working, and every field must be hand-editable
- Don't handle API keys — `gh` and `claude` own auth
- Don't let a re-review discard human work: comments the user wrote or edited
  are carried across (`carryOverComments`), never regenerated away. A chat turn
  is the second way to lose it — it refuses to rewrite the user's own comments,
  and its result is folded onto the current artifact (`mergeConcurrentEdits`)
  rather than overwriting whatever they edited while the turn ran
- Don't add an accept step to a revision the user asked for. The chat agent
  writes the draft directly; Send is where a human vouches for what reaches
  GitHub, and one pre-chat snapshot is the way back. A per-turn undo is
  propose/accept machinery wearing a different name
- Don't start an AI run without claiming `runner/inflight` — the daemon's timer
  and the cockpit's button both write the same artifact file
- Don't hold an HTTP request open for an AI run. A review and a chat turn both
  take minutes: they start detached, answer `202`, and put their state on the
  artifact (`status: running`, `pendingChat`) for the cockpit to poll — failures
  included, since there is no response left to hand them to. A held request dies
  at a reverse proxy's read timeout and tells the user it broke while the run
  quietly succeeds
- Don't give the review run a tool it doesn't need. The default run reads and
  nothing else, and treats everything in the checkout as untrusted PR content
  rather than instructions. Only a PR the user trusted (`config.json`, `--trust`)
  gets Bash — and never Edit/Write: a review reads and runs, it doesn't fix
- Don't let a run hold GitHub credentials. Bash plus a stored credential would
  make "nothing reaches GitHub without a Send" a request rather than a fact:
  the fetch credential is per-command, and the run's env blanks the tokens,
  disables git's global *and* system config (`GIT_CONFIG_NOSYSTEM`), and closes
  ssh (no agent, no default identity). It is not a sandbox — say so rather than
  implying one
- Don't let anything but the user grant trust. Not the PR, not its author's
  association, not a heuristic — trust is a claim about people, stated up front
- Don't let a repo stand in for the people who can open PRs against it. A repo
  takes PRs from anyone, so cerber refuses repo-shaped trust rules outright
  rather than qualifying them; a failed membership lookup means "not a member"
- Don't make the checkout a precondition — it's on by default, but if git or
  `gh` can't produce one, log it and review the diff alone
