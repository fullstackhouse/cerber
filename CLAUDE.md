# CLAUDE.md

Cerber: AI code-review cockpit. Claude reviews PRs into local JSON artifacts;
the user walks through them in a local React cockpit. **Hard rule: cerber never
writes to GitHub except (a) an explicit, user-confirmed Send, or (b) daemon
auto-send that the user explicitly enabled with --auto-send — approve-only,
confidence-threshold-gated, every decision logged to autosend.ndjson. No
pending reviews, no comments, no reactions — reviewing is read-only.**

## Architecture

- `src/core/` — artifact schema (zod, versioned — the contract between AI and
  cockpit), state store (`~/.cerber/reviews/*.json`, plain JSON, no DB),
  gh client (shells out to `gh`, no tokens handled), diff utils,
  re-anchoring (`anchor.ts`/`refresh.ts` — pulls a review onto a newer head by
  matching each comment's line *text*, never a fuzzy guess), source checkouts
  (`checkout.ts` — shallow `refs/pull/N/head` clone per PR under `~/.cerber/src`;
  an LRU cache of 8, evicted as reviews run, reclaimable with `cerber prune`),
  trust rules (`trust.ts` — rule syntax and matching; `@org/team` and `@org/*`
  trust people, repo rules additionally require the PR to be pushed to the repo
  rather than a fork; denials win) and settings
  (`config.ts` — `~/.cerber/config.json`, zod-validated, written by the CLI and
  the cockpit's settings screen)
- `src/runner/` — review prompt + headless `claude -p --output-format json`
  runner (rides the user's login; prompt on stdin; validate output with zod,
  retry once on bad JSON). Runs inside the PR checkout with `Read`/`Grep`/`Glob`
  only; `--no-source` reviews the diff alone, with every tool off and an empty cwd
- `src/server/` — Hono API + static cockpit serving
- `src/cli/` — commander CLI (`review`, `list`, `serve`)
- `web/` — Vite + React cockpit; imports shared diff utils from `../src/core/diff`

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
  are carried across (`carryOverComments`), never regenerated away
- Don't start an AI run without claiming `runner/inflight` — the daemon's timer
  and the cockpit's button both write the same artifact file
- Don't give the review run a tool it doesn't need. The default run reads and
  nothing else, and treats everything in the checkout as untrusted PR content
  rather than instructions. Only a PR the user trusted (`config.json`, `--trust`)
  gets Bash — and never Edit/Write: a review reads and runs, it doesn't fix
- Don't let anything but the user grant trust. Not the PR, not its author's
  association, not a heuristic — trust is a claim about people, stated up front
- Don't let a repo stand in for the people who can open PRs against it. A
  public repo takes PRs from anyone, so repo-shaped rules apply only to
  non-fork branches, and a failed membership lookup means "not a member"
- Don't make the checkout a precondition — it's on by default, but if git or
  `gh` can't produce one, log it and review the diff alone
