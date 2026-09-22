# The demo harness

A fully-offline cerber: five pull requests, five drafted reviews, a working
Send — and no GitHub account, no Anthropic API, no network at all.

It exists so the cockpit can be recorded. A screen recording of a real inbox is
not reproducible (the queue changes under you) and not safe (the Send button
writes to somebody's PR). This makes both true at once, without a demo mode in
the product: **nothing under `demo/` is imported by cerber, and no product code
knows this directory exists.** The harness works by `PATH` and `CERBER_HOME`
alone.

> **The data is fiction.** `northwind` is not a real GitHub org, `marta-k`,
> `tomek-r` and `ada-w` are not real people, and the five PRs, their diffs and
> the reviews of them were written for this directory. Nothing here came from a
> real repository, a real review, or a real model run.

## Run it

```bash
demo/run.sh            # cockpit on http://127.0.0.1:4830
demo/run.sh 4900       # …or a port of your choosing
```

The first run builds the cockpit (`pnpm build`) if `web/dist` is missing.
Every run wipes `demo/home/` and re-drafts all five reviews, so the screen you
start recording is the same screen every time. Ctrl-C to stop.

Requires `pnpm install` to have been run in the repo, and a real `git` on PATH
(cerber's preflight checks for it; nothing in the demo actually uses it).

## How it works

cerber shells out to exactly three programs: `gh`, `claude` and `git`.
`run.sh` puts `demo/bin` at the front of `PATH`, so the first two resolve to
stubs in this directory. Everything else is cerber itself, running for real:
the same fetch, the same prompt builder, the same artifact schema, the same
queue, the same send path.

| | |
|---|---|
| `bin/gh` | Answers every `gh` argv shape cerber uses, from `fixtures/`. The one write (`POST …/pulls/N/reviews`) is recorded to `$CERBER_HOME/sent/` and never leaves the machine. |
| `bin/claude` | Reads the prompt on stdin, decides whether it is cerber's review prompt or its chat prompt, and replays the canned payload for that PR as `stream-json` events. |
| `bin/package.json` | One line: `{"type": "module"}`. The stubs are extensionless so they can be named `gh` and `claude`; this is what tells Node they are ESM. |
| `fixtures/` | The data. One directory per PR, plus one per PR of canned model output. |
| `home/` | The scratch `CERBER_HOME`. Gitignored, wiped on every run. |

**Unknown invocations fail loudly.** A stub that answered an unrecognised call
with empty output would turn a typo into an empty inbox, and an empty inbox
looks exactly like a broken product. Both stubs instead exit non-zero and print
the argv they were handed.

`run.sh` passes `--no-source`, so no checkout is made and `git` is never
invoked: the fixtures are diffs, not repositories. The reviews say so about
themselves — each verdict names what it could not check without the source,
which is what a diff-only review honestly looks like. It also passes
`--no-poll`, so the queue is exactly the five PRs drafted at boot and stays
that way while the camera is running.

`CERBER_DEMO_STEP_MS` (default 350) is the pause between narration events, so
the cockpit's progress strip is readable on camera. The boot-time drafting runs
with it at 0.

## The fixture PRs

| # | Repo | Title | Author | Verdict | Findings |
|---|---|---|---|---|---|
| 812 | `northwind/checkout` | fix(payments): retry failed webhooks with backoff | `marta-k` | request changes, 91% | 1 blocker, 1 minor, 1 nit |
| 809 | `northwind/checkout` | feat(cart): show promo codes on the summary line | `tomek-r` | approve, 88% | 2 minor |
| 1440 | `northwind/web` | chore(deps): bump next to 15.4.2 | `renovate[bot]` | approve, 94% | — |
| 805 | `northwind/checkout` | refactor(orders): split the fulfilment service | `ada-w` | approve, 76% | 2 minor, 2 nit |
| 231 | `northwind/billing` | feat(invoices): VAT rounding per line | `marta-k` | comment, 68% | 2 minor |

**#812 is the one to film.** Its diff contains a real bug of a real class: the
new retry path re-enters the charge with nothing keyed to the Stripe event, so
a redelivered webhook charges the customer twice. The blocker is anchored to
`src/payments/webhook-handler.ts:15`, the line that re-enters it. The other two
findings are ordinary review noise — a swallowed error and a naming nit — so
one can be dropped on camera without the review losing its point.

#812 also has a scripted chat exchange. Ask the reviewer anything matching
*double-charge / dedupe / Stripe replay / idempotency*, for example:

> does this actually double-charge, or does Stripe dedupe the replay for us?

and it answers that Stripe retries with the same event id while the handler
keys off the payment intent, then rewrites the blocker to say exactly that —
visibly tighter than the original. Every other PR has a single fallback reply,
so clicking into a chat off-script never errors on camera.

## Adding a fixture PR

Say you want `northwind/web#1500`. The key is `owner__repo__number`.

1. **The PR.** `fixtures/prs/northwind__web__1500/`:
   - `pr.json` — what `gh pr view --json …` returns. The `_owner`, `_repo`,
     `_number` and `_updatedAt` fields are the stub's own bookkeeping (they
     feed `gh search prs`); everything else is a field cerber asks for by name,
     and asking for one that is missing is an error rather than a silent null.
   - `diff.patch` — the unified diff, exactly as `gh pr diff` prints it.
   - `review-requests.json`, `review-request-events.json`, `reviews.json`,
     `issue-comments.json` — only read when polling is on. Copy an existing
     PR's and edit.
2. **The review.** `fixtures/claude/northwind__web__1500/review.json`:
   - `review` — the object cerber's `AiReviewSchema` validates: `summary`,
     `chapters`, `comments`, `verdict`. `src/core/artifact.ts` is authoritative.
   - `progress` — the lines the run narrates while it works. A string is a text
     event; `{"tool": "Read", "input": {...}}` is a tool event.
   - `costUsd`, and optionally `wrap`, a template with `{{json}}` in it for
     wrapping the answer in prose (PR 1440 uses it — cerber's `extractJson` is
     supposed to cope, and that fixture is where it gets exercised).
3. **The chat.** `fixtures/claude/northwind__web__1500/chat.json`: a list of
   `turns`, each with a `match` regex against the user's message, a `reply`,
   and optional `revisions`; plus a `fallback` for anything unmatched. A
   revision names its target comment as `"commentAt": "path/to/file.ts:42"` —
   comment ids are minted per run, so the stub resolves them out of the prompt.
4. **Line numbers must be real.** A comment anchors inline only if its line is
   an added or context line inside a hunk. To check:
   ```bash
   node -e 'import("./dist/core/diff.js").then(async d=>{
     const {readFileSync}=await import("node:fs");
     for (const [p,l] of d.newSideLineText(readFileSync(process.argv[1],"utf8")))
       console.log(p, [...l.keys()].join(","))
   })' demo/fixtures/prs/northwind__web__1500/diff.patch
   ```
   Anything else is folded into the review body instead — visible in the
   cockpit's send preview as "folded into body".
5. **Add it to `run.sh`'s `cerber review` line.**

## Verifying a change to the harness

```bash
demo/run.sh 4830 &
curl -s localhost:4830/api/reviews | jq -r '.[] | "\(.id) \(.status) \(.verdict.recommendation)"'
curl -s 'localhost:4830/api/reviews/northwind__checkout__812/send-preview?event=REQUEST_CHANGES' \
  | jq '{inline: (.comments|length), folded: (.folded|length)}'
```

Five rows, all `ready`, and three inline comments with nothing folded. Then
press Send in the cockpit and read `demo/home/sent/`.
