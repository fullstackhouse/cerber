# Security

## Reporting a vulnerability

Open a [private security
advisory](https://github.com/fullstackhouse/cerber/security/advisories/new), or
email **hello@fullstack.house** with `cerber` in the subject. Please don't open a
public issue for anything exploitable. Expect a first reply
within a few working days; this is a small team, not a 24/7 rota.

## What cerber can do on your machine

Worth knowing before you run it, because two of these are unusual:

**It holds your GitHub credentials and can post as you.** Cerber shells out to
`gh`, authenticated as you. Reviews it sends are your reviews, under your
account. The only code path that writes to GitHub is a human-initiated send
(`src/core/send.ts`), plus `--auto-send`, which you turn on yourself and which
is approve-only, threshold-gated and logged to `~/.cerber/autosend.ndjson`.
Everything else — discovery, drafting, refreshing — is read-only.

**On a trusted PR, it runs that PR's code.** A review of a PR matching one of
your trust rules may execute commands in the checkout: the test suite, a build,
a typecheck. That is the feature (`## Trusted PRs` in the README), and it means
a trusted author's branch runs on your machine. Consequences:

- **Trust people, never repositories.** Cerber enforces this — a repo pattern is
  rejected — because anyone can open a PR against a repo you own.
- **Trusted runs are stripped of credentials.** The subprocess gets no `gh`
  config, no `GH_TOKEN`/`GITHUB_TOKEN`, no global or system git config, no SSH
  agent, and an `ssh` with no identity at all (`unauthenticatedEnv`,
  `src/runner/claude.ts`). This was measured, not assumed: both an https push and
  an ssh push succeeded before the last of those were closed. It stops a trusted
  run from *pushing as you* — **it is not a sandbox**, and it does not stop the
  code from reading your disk or reaching the network.
- **Untrusted PRs are read-only.** No commands run. `--no-trust` forces that for
  every review in a session, including unattended ones.
- **Membership checks fail closed.** A lookup cerber cannot complete — no
  `read:org` scope, an outage, a 404 — counts as *not* a member. A broken check
  never reads as trust.

**It binds a local web server.** `cerber serve` listens on `127.0.0.1:4820` with
no auth, which is the same trust boundary as any other localhost dev server.
Binding anything else is refused unless you pass `--token` (or `CERBER_TOKEN`);
`--insecure` overrides that and should not be used on a shared network. Anyone
who can reach that port can send reviews as you.

**Your code goes to Anthropic.** Reviews are drafted by running `claude` on your
machine, so the diff — and, on a `--with-source` run, the checked-out files —
are sent to Anthropic's API under your own Claude Code account and its terms.
"Local-first" here means *the artifacts, the state and the decision are local and
nothing is posted without you*. It does not mean the model runs locally.

## State on disk

Everything lives in `~/.cerber` (`CERBER_HOME` overrides it): review artifacts
under `reviews/`, cached PR checkouts under `src/`, config in `config.json`, the
auto-send ledger in `autosend.ndjson`. **Artifacts contain the diff under
review** — treat them like the source they quote, and `cerber prune` the
checkouts when you're done.

## Supported versions

The latest released version on npm. Fixes ship forward; there are no backported
patch branches.
