# cerber 🐕

**AI code-review cockpit.** Claude reviews your pull requests into local artifacts —
a summary, a chaptered walkthrough of the changes, draft inline comments, and a
verdict with a confidence score. You go through it in a local web cockpit.

**Nothing reaches GitHub until you explicitly say so.** Cerber's only GitHub
writes happen when you hit Send (coming in a later phase) — reviewing is 100%
local and read-only.

Named after Cerberus, the gatekeeper — and a sibling of
[cezar](https://github.com/open-mercato/cezar): cezar runs coding agents,
cerber guards what gets merged.

## Quick start

Requires Node 20+, an authenticated [`gh`](https://cli.github.com/) and a
logged-in [`claude`](https://claude.com/claude-code) CLI. No API keys, no config, no database.

```bash
# Review a PR (writes a local artifact to ~/.cerber, nothing else)
npx @fullstackhouse/cerber review https://github.com/owner/repo/pull/123

# Review several
npx @fullstackhouse/cerber review owner/repo#123 owner/repo#124
npx @fullstackhouse/cerber review 123 124 --repo owner/repo

# See what's in the queue
npx @fullstackhouse/cerber list

# Open the cockpit
npx @fullstackhouse/cerber serve        # → http://127.0.0.1:4820
```

## What a review looks like

Each review is a plain JSON artifact in `~/.cerber/reviews/` (override with
`CERBER_HOME`) containing:

- **Summary** — what the PR actually does and why, written top-down
- **Chapters** — the changed files grouped into a logical walkthrough, each
  with a title, an explanation, and its slice of the diff
- **Draft comments** — inline, anchored to file/line, only things worth a
  human's time
- **Verdict** — approve / comment / request changes, with a 0–100 confidence
  score and reasoning

The cockpit (`cerber serve`) renders the queue and the per-PR walkthrough with
diffs. Artifacts are plain JSON you can `cat`, edit, or pipe into anything.

## Status / roadmap

Early. Current phase: review + read-only cockpit.

1. ✅ `cerber review <pr>` + artifact schema + cockpit (read-only)
2. ✅ Comment editing in the cockpit (edit/approve/drop/add), verdict override,
   gated **Send** (double-confirm; posts the review via your `gh` — the only
   GitHub write in the codebase) + `cerber export` to markdown
3. ✅ `--awaiting-me` discovery, parallel runs (`--parallel`, default 3),
   freshness skip (same head SHA → no re-run; `--force` overrides), queue stats
4. Daemon/VPS mode: poll for PRs awaiting your review, review them
   automatically, cockpit always warm
5. Confidence calibration → shadow-mode auto-send → opt-in auto-send above a
   threshold

## Development

```bash
pnpm install
pnpm dev review <pr>     # run the CLI from source
pnpm dev serve           # API on :4820
pnpm --dir . typecheck && pnpm test
pnpm build               # dist/ (CLI+server) + web/dist (cockpit)
```

Web cockpit dev with hot reload: `pnpm dev serve` in one terminal,
`npx vite --config web/vite.config.ts` in another (proxies `/api`).

## License

MIT © Full Stack House
