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
4. ✅ Daemon/VPS mode: `cerber serve --daemon` polls for PRs awaiting your
   review and reviews them automatically (read-only); token auth for
   non-localhost binds
5. ✅ Confidence calibration (`cerber stats`), shadow-mode auto-send (default
   in daemon: logs what would be sent), opt-in `--auto-send` (approve-only,
   `--auto-send-threshold`, default 90%)

## Running on a VPS

```bash
cerber serve --daemon --host 0.0.0.0 --token "$(openssl rand -hex 16)" \
  --repo you/repo-a --repo you/repo-b --interval 10
```

The daemon polls GitHub, reviews anything new (skipping PRs whose artifact
already matches the head SHA), and the cockpit is always warm — open it any
minute and see pending/ready/sent reviews. Auth: `?token=…` once in the
browser (sets a cookie) or `Authorization: Bearer …`. Binding a non-localhost
host without a token is refused. By default the daemon never sends reviews — Send stays a human click.

**Auto-send** (opt-in): add `--auto-send --auto-send-threshold 90` and the
daemon will submit APPROVE verdicts at/above the threshold as you. It never
auto-sends COMMENT or REQUEST_CHANGES. Before enabling, run the default
shadow mode for a while: every would-send decision lands in
`~/.cerber/autosend.ndjson`, and `cerber stats` shows how often the AI's
verdicts and comments survive your review — enable auto-send when its 90%
actually means 90%.

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
