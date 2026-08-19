# cerber 🐕

**AI code-review cockpit.** Claude reviews your pull requests into local artifacts —
a summary, a chaptered walkthrough of the changes, draft inline comments, and a
verdict with a confidence score. You go through it in a local web cockpit.

**Nothing reaches GitHub until you explicitly say so.** Cerber's only GitHub
write is the Send button (plus opt-in daemon auto-send you turn on yourself) —
reviewing is 100% local and read-only.

Named after Cerberus, the gatekeeper: cerber guards what gets merged.

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

# Open the cockpit — it's an inbox: it polls GitHub for PRs awaiting your
# review and drafts a review for each, so they're ready when you arrive
npx @fullstackhouse/cerber serve        # → http://127.0.0.1:4820
```

`serve` does the whole loop by default: discover → draft → wait for you.
Sending stays a human click. Tame it with `--no-auto-review` (list awaiting
PRs, review on click) or `--no-poll` (no GitHub polling at all) — or flip the
same two switches in the cockpit's Settings, which persist in
`~/.cerber/config.json` and apply on the next poll. The queue only lists what
still wants you: anything you have settled drops into a drawer under it — one
for reviews you sent, one for the ones you marked reviewed or skipped, one for
merged and closed PRs — and PRs in archived repos are never picked up at all,
since the repo is read-only and a review could never be sent.

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
- **Run metadata** — model, whether it read the source or only the diff, and
  the token spend as an API-rate equivalent

The cockpit (`cerber serve`) renders the queue and the per-PR walkthrough with
diffs. Artifacts are plain JSON you can `cat`, edit, or pipe into anything.

The queue is meant to be walked, not clicked through: `j`/`k` move the cursor
and the strip under the table explains whatever it lands on — the verdict's own
reasoning, what the run read, how it sits against the auto-send bar — so most
rows can be judged without opening them. `↵` opens one, `r` drafts (or
re-drafts) it. Inside a review, `[` and `]` walk to the previous/next PR still
awaiting you, `n` steps through the chapters, and `s` sends.

### It reviews the code, not just the diff

Cerber checks the PR's head out locally and lets the review read it. That
matters because a reviewer holding only a diff hedges over things it could have
just looked up — *"I can't see the enclosing function, so this could be
wrong"* — and burns its confidence score on missing context instead of on real
uncertainty. With the source there, it opens the enclosing function, follows
callers of a changed signature, checks whether a helper already exists, and
sees whether a test covers the new path.

On one real PR, same commit, the difference was: a speculative "this *looks
like* it sits after an early return" became a concrete finding; a permission
check the diff showed as a tidy gate turned out to hide a value the API
response still ships; confidence went 72% → 82%. It burned 3.3× the tokens and
took three minutes instead of one.

Cerber rides your `claude` login, so a review isn't billed per run: on a Claude
subscription it draws on your usage limits. The `≈$` figures in the CLI and
cockpit are what those tokens would cost at API token rates — read them as
"how much of the plan did this eat", not as an invoice.

If you want the old behaviour — faster, lighter, blind past the changed lines:

```bash
cerber review owner/repo#123 --no-source
cerber serve --no-source
```

The cockpit labels every review "read the full source" or "read the diff only",
and offers a one-click **Re-review with full source** on the diff-only ones.

Details worth knowing:

- The checkout is a shallow (`--depth=1`) fetch of `refs/pull/N/head` from the
  base repo, so fork PRs work with no extra remotes. Auth rides `gh`'s
  credential helper, set on that clone only — your git config is untouched.
- If git or `gh` can't produce a checkout, the run says so and reviews the diff
  alone. A missing checkout never fails a review.
- The run is read-only unless you have trusted the PR (see below): `Read`,
  `Grep` and `Glob` are the only tools it gets. Without a checkout it gets none,
  and runs in an empty directory, so it can never read whatever project cerber
  happens to be started from and mistake it for the PR.
- PR content is untrusted, and `claude -p` skips the workspace-trust prompt, so
  cerber does the distrusting itself: a `.claude/settings.json` or `.mcp.json`
  in the checkout is renamed aside (still readable, no longer loaded), hooks
  and non-cerber MCP servers are off, and the prompt tells the reviewer that
  instructions found in files are material to review, not directions to follow.
  What a hostile PR can still do is skew the review text — it cannot run
  anything, write anything, or reach the network. Read the verdict, don't
  rubber-stamp it. (All of this applies to PRs you have *not* trusted; a
  trusted one is deliberately given the run of the place.)
- Checkouts live in `~/.cerber/src/<owner>__<repo>__<n>` and are reused by later
  re-reviews. A big monorepo is a few hundred MB per PR, so the cache keeps only
  the 8 most recently reviewed and evicts the rest as it goes — never one a
  review is currently reading. `cerber prune` reclaims the space now;
  `cerber prune --all` takes the ones for reviews still awaiting you too.

### Trusted PRs: reviews that can run things

Reading beats guessing, but running beats reading. A review that ran the test
covering the change reports what happened; one that only read it guesses. So
for PRs you already trust — a teammate's, or anything in your own repos —
cerber can let the review run commands in the checkout: the test suite, a
typecheck, `git log`/`git blame`, a build.

Trust is about the *people*, and only about people — cerber has no way to
trust a repository, because anyone can open a PR against one:

```bash
cerber trust @fullstackhouse/*      # anyone in the org
cerber trust @fullstackhouse/devs   # anyone on that GitHub team
cerber trust @teammate              # one person, by login
cerber trust                        # show who is trusted today
```

Membership is resolved against GitHub when the review runs (your `gh` login
needs `read:org`), and a lookup that fails counts as "not a member" — a check
cerber could not complete never reads as trust. Writing a repo instead of a
person is rejected, in the CLI, the cockpit, and on config load:

```
$ cerber trust acme/widgets
"acme/widgets" is not a trust rule. Trust is about people, not repositories —
anyone can open a PR against a repo you own, so trusting the repo would trust
them too. Use @acme/* for everyone in that org, @acme/team for one team, or
@login for a person.
```

Rules live in `~/.cerber/config.json`, and the cockpit has a **settings**
screen that reads and writes the same file — each rule shown with what it
actually grants. A `!` rule denies and beats every grant, so `@fullstackhouse/*`
plus `!@fullstackhouse/contractors` does what it looks like. `--trust` and
`--no-trust` override the config for one run; `cerber trust <pattern> --delete`
removes a rule.

A trusted review gets `Bash`, `WebFetch` and `WebSearch` on top of reading, and
the repo's own `.claude` config applies — it behaves as if you had checked the
branch out and opened it yourself. The cockpit labels it "ran the code" so you
know which kind you are reading.

It is handed no GitHub credentials, and that part is *enforced* rather than
requested. `GH_CONFIG_DIR` points at a fresh empty directory, `GH_TOKEN` and
`GITHUB_TOKEN` are blanked, the fetch credential rides the fetch command
instead of being stored in the checkout, git's global and system config are
switched off so a keychain helper cannot stand in, and the ssh route is closed
too — no agent, no `~/.ssh/config`, no default identity — since otherwise a run
could point the remote at `git@github.com` and ride your keys. Measured from
inside a checkout: `git push` over https and over ssh, and `gh pr comment`, all
fail to authenticate, while `git log` still works.

**It is not a sandbox, and you should not read it as one.** A trusted run has
`Bash` and your filesystem: it can write files in the checkout, and a
determined one could read a key straight out of `~/.ssh` and use it itself.
What cerber guarantees is that it *hands* the run nothing. The rest is what
trusting a person means — which is why trust is spelled `@org/team`, and why
the default is a review that cannot run anything at all.

**What you are accepting.** A trusted review executes code from that PR on your
machine — the branch's scripts, its dependencies, its test suite. That is the
same exposure as checking the branch out and running the tests yourself, which
is what you would otherwise do; it is not the same as reading a diff. Trust
orgs and people, not the whole of GitHub. And note that `cerber serve` reviews
unattended by default: with trust rules set, it will run matching PRs' code
with nobody watching. It warns at startup, the cockpit shows a ⚡ badge while
it's the case, and `--no-trust` (or `--no-auto-review`) turns it off.

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

### Arguing with the review before you send it

A draft you disagree with used to leave two options: rewrite it by hand, or
re-review and hope. Neither lets you say *what was wrong*. So every review has
a conversation attached — **Talk to the reviewer**, at the bottom of the
walkthrough.

Ask it why it said something, and it answers. Tell it the summary is restating
the author's claims rather than what it verified, and it rewrites the summary.
The reviewer revises the draft as it answers: there is no accept step, because
you already asked for the change. What it changed shows up in the transcript
(*"✎ rewrote the summary"*, *"✎ dropped the comment on line 250"*).

- **It is the same reviewer.** A turn resumes the Claude session the review ran
  in, so it still holds everything it read. Asking "did you actually check
  that?" gets an answer from the run that did or didn't — not from a fresh
  agent re-deriving an opinion from the diff.
- **It reads the code to answer you.** The checkout cache is small, so by the
  time you argue with a review its source is usually evicted; a turn re-clones
  it. If it can't, the turn still runs and the reviewer is told it is working
  blind rather than left to describe files from memory.
- **It can say no.** The prompt tells it not to fold under push-back. If you
  are wrong about something it checked, it says so and changes nothing.
- **The wait is not a held request.** Re-reading the code takes minutes, so a
  turn runs detached the way a re-review does: your question appears in the
  transcript straight away and the cockpit polls for the answer. Reload, close
  the tab, or sit behind a proxy that times connections out at 60s — the answer
  still lands on the review, and a turn that fails says so against the question
  that caused it.
- **You can watch it work.** Those minutes aren't a spinner: the run narrates
  itself under your question — *thinking…*, *reading src/core/refresh.ts*,
  *searching for carryOverComments in src*, *not allowed to use Bash* — so you
  can tell a turn that is checking your claim from one that is about to answer
  from memory. `cerber review` and the daemon log print the same lines.
- **Your words are yours.** Comments you wrote or edited are off limits: it
  will tell you one of them needs changing rather than rewriting it. Say so
  explicitly and it will.
- **Point at things.** *discuss* on any comment, chapter, or the summary drops
  a reference into your next message.
- **Reset** puts the review back the way the AI first wrote it and keeps the
  conversation — you lose the edits, not the reasoning.

Nothing in the conversation reaches GitHub. Send still builds its payload from
the summary, comments and verdict alone, and is still one deliberate click. A
review that has already been sent can't be argued with: that artifact is the
record of what GitHub has.

## Status / roadmap

Early, but all six planned phases have shipped.

1. ✅ `cerber review <pr>` + artifact schema + cockpit (read-only)
2. ✅ Comment editing in the cockpit (edit/approve/drop/add), verdict override,
   gated **Send** (one deliberate click; posts the review via your `gh` — the
   only GitHub write in the codebase) + `cerber export` to markdown
3. ✅ `--awaiting-me` discovery, parallel runs (`--parallel`, default 3),
   freshness skip (same head SHA → no re-run; `--force` overrides), queue stats
4. ✅ Inbox mode (now the default): `cerber serve` polls for PRs awaiting your
   review and reviews them automatically; token auth for non-localhost binds
5. ✅ Confidence calibration (`cerber stats`), shadow-mode auto-send (default
   in daemon: logs what would be sent), opt-in `--auto-send` (approve-only,
   `--auto-send-threshold`, default 90%)
6. ✅ Reviews keep up with the PR: opening one re-anchors its comments onto new
   commits, flags the ones whose code is gone, and offers a re-review that
   keeps everything you wrote

## Running on a VPS

```bash
cerber serve --host 0.0.0.0 --token "$(openssl rand -hex 16)" \
  --repo you/repo-a --repo you/repo-b --interval 10
```

The server polls GitHub, reviews anything new (skipping PRs whose artifact
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

MIT © [Full Stack House](https://fullstack.house)
