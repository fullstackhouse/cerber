# Inbox by default

**Itch:** opening cerber shows stale artifacts, not the PRs actually awaiting review. The automatic path (`serve --daemon`) exists but is opt-in and invisible.

**Decision (user-confirmed):** plain `cerber serve` becomes a full inbox — poll + auto-review by default, drafts ready when the user arrives. Fewest clicks wins every tie.

## Design

- `serve` always runs the daemon loop. Two knobs, both default **on**:
  - `poll` — discover PRs awaiting review (`gh search prs --review-requested=@me`), upsert stub artifacts with the existing-but-unused `awaiting` status
  - `autoReview` — review whatever lands in `awaiting` (pooled)
- Config: `daemon: { poll, autoReview, intervalMinutes: 5, parallel: 3, repos: [] }` block in config.json (zod defaults; absent keeps working). Settings screen gets the two toggles; CLI flags `--no-poll` / `--no-auto-review` override per-invocation; `--daemon` becomes a deprecated no-op.
- Bare `cerber` (no subcommand) runs `serve`.
- Self-cleaning: each poll refreshes PR state; merged/closed PRs are archived out of the default queue view.
- Trust: **honored in unattended runs** (user choice, option a) — startup warning stays, daemon strip shows a visible "trusted PRs run with Bash" indicator. `--no-trust` still opts out.
- Auto-send: untouched, stays opt-in. No GitHub writes without explicit action.
- Degrade gracefully: gh unauthed/offline → queue serves local artifacts + dim "discovery offline" notice; search failures never break the queue.

## Challenger findings folded in

- Stub artifacts with `awaiting` status, NOT a parallel "ghost row" type (schema landing pad exists at artifact.ts:61)
- One poll loop, parameterized — never two pollers
- Discovery is a server-side interval, never coupled to queue GETs (rate limits, offline)
- Claim inflight before mutating artifact status (don't copy the rerun race)
- Pool unattended reviews; don't spawn N unbounded claude processes
- Dedup/status from local artifacts, never from search presence (search is eventually consistent)
- Open follow-up: team-review-requested union (CODEOWNERS/team-routed requests don't match `@me` search) — verify need before building

## Out of scope

Auto-send changes; team-review-requested union (follow-up); cockpit "review all" button (moot — auto-review is on by default; per-row review button still ships for `autoReview: false` mode)
