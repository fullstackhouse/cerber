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
  gh client (shells out to `gh`, no tokens handled), diff utils
- `src/runner/` — review prompt + headless `claude -p --output-format json`
  runner (rides the user's login; prompt on stdin; validate output with zod,
  retry once on bad JSON)
- `src/server/` — Hono API + static cockpit serving
- `src/cli/` — commander CLI (`review`, `list`, `serve`)
- `web/` — Vite + React cockpit; imports shared diff utils from `../src/core/diff`

## Conventions

- TypeScript strict, ESM (NodeNext in src/, bundler in web/)
- State files are user-editable: read defensively, write atomically (tmp+rename)
- Zero config: ride existing `gh`/`claude` logins, degrade gracefully
- `pnpm typecheck && pnpm test` must pass before commit
- Conventional commits

## Don'ts

- Don't add GitHub write calls anywhere except the (future) explicit send path
- Don't add a database or config wizard — plain files, zero config
- Don't handle API keys — `gh` and `claude` own auth
