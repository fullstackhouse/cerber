# cerber 🐕

**AI code-review cockpit.** Claude reviews your pull requests into local artifacts —
a summary, a chaptered walkthrough of the changes, draft inline comments, and a
verdict with a confidence score. You go through it in a local web cockpit.

**Nothing reaches GitHub until you explicitly say so.** Cerber's only GitHub
write is the Send button (plus opt-in daemon auto-send you turn on yourself) —
reviewing is 100% local and read-only.

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

### Reviewing the code, not just the diff

By default the reviewer sees only the unified diff — the same thing you see on
GitHub, minus the ability to click through to the rest of the file. That is
fast and cheap, but it makes the AI hedge: *"I can't see the enclosing
function, so this could be wrong."*

Add `--with-source` and cerber checks the PR head out locally first, then lets
the review read it:

```bash
cerber review owner/repo#123 --with-source
cerber serve --daemon --with-source     # every daemon run and cockpit re-review
```

The run can then open the enclosing function, follow callers of a changed
signature, check whether a helper already exists, and see whether a test covers
the new path — instead of guessing at any of it. It is slower and costs more
per review; the cockpit labels every review "read the full source" or "read the
diff only" so you know which one you are reading, and offers a one-click
**Re-review with full source** on the diff-only ones.

Details worth knowing:

- The checkout is a shallow (`--depth=1`) fetch of `refs/pull/N/head` from the
  base repo, so fork PRs work with no extra remotes. Auth rides `gh`'s
  credential helper, set on that clone only — your git config is untouched.
- The run is read-only: `Read`, `Grep` and `Glob` are the only tools it gets.
  Without a checkout it gets none, and runs in an empty directory, so it can
  never read whatever project cerber happens to be started from and mistake it
  for the PR.
- PR content is untrusted, and `claude -p` skips the workspace-trust prompt, so
  cerber does the distrusting itself: a `.claude/settings.json` or `.mcp.json`
  in the checkout is renamed aside (still readable, no longer loaded), hooks
  and non-cerber MCP servers are off, and the prompt tells the reviewer that
  instructions found in files are material to review, not directions to follow.
  What a hostile PR can still do is skew the review text — it cannot run
  anything, write anything, or reach the network. Read the verdict, don't
  rubber-stamp it.
- Checkouts live in `~/.cerber/src/<owner>__<repo>__<n>` and are reused by later
  re-reviews. They are a cache — `cerber prune` (or `--all`) reclaims the space,
  and a big monorepo is a few hundred MB per PR.

### When the PR moves under you

A review is written against one commit, but authors keep pushing. Opening a
review checks the PR's head and pulls the review forward: comments follow their
code to its new line numbers, and any whose code is gone are flagged and post
in the review body instead of inline — GitHub rejects an entire review over one
comment on a line that is no longer in the diff. Sends carry the reviewed
commit's SHA, so inline comments land where they were written.

The AI's summary and verdict still describe the commit that was reviewed. To
get its opinion of the new code, hit **Re-review at the new head** in the
cockpit (or `cerber review <pr> --force`) — comments you wrote or rewrote are
carried into the fresh review.

## Status / roadmap

Early, but all six planned phases have shipped.

1. ✅ `cerber review <pr>` + artifact schema + cockpit (read-only)
2. ✅ Comment editing in the cockpit (edit/approve/drop/add), verdict override,
   gated **Send** (one deliberate click; posts the review via your `gh` — the
   only GitHub write in the codebase) + `cerber export` to markdown
3. ✅ `--awaiting-me` discovery, parallel runs (`--parallel`, default 3),
   freshness skip (same head SHA → no re-run; `--force` overrides), queue stats
4. ✅ Daemon/VPS mode: `cerber serve --daemon` polls for PRs awaiting your
   review and reviews them automatically (read-only); token auth for
   non-localhost binds
5. ✅ Confidence calibration (`cerber stats`), shadow-mode auto-send (default
   in daemon: logs what would be sent), opt-in `--auto-send` (approve-only,
   `--auto-send-threshold`, default 90%)
6. ✅ Reviews keep up with the PR: opening one re-anchors its comments onto new
   commits, flags the ones whose code is gone, and offers a re-review that
   keeps everything you wrote

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
