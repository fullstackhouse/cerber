# Code review

`om-code-review` (and therefore `om-auto-review-pr`) reads this file automatically and applies it on top of its built-in checklist.

**Start from `CLAUDE.md`.** Its Don'ts and Conventions are the review rules for this repository — the GitHub write boundary, tool grants and credential blanking, trust semantics, `carryOverComments`, the `runner/inflight` claim, atomic state writes, no DB or wizard, no API keys, TS strict/ESM, conventional commits. Reviewers read it first; this file only adds what it does not state.

## Additional checks

- **Artifact schema compatibility.** In `src/core/artifact.ts`, a field added with `.default()` is backward-compatible; a field made required, renamed, or narrowed is not, and needs `SCHEMA_VERSION` bumped plus a migration path for artifacts already in `~/.cerber/reviews/`. Users' saved reviews outlive any release.
- **Shelling out.** External commands use `execFile` with an argument array, never a shell string — see `src/core/gh.ts`. A shell interpolation carrying a PR-sourced value is a blocker.
- **Tests.** Vitest, colocated as `*.test.ts` beside the module. A behavior change in `src/core/` without one is a finding.

## Severity

The verdict follows from these, so calibrate deliberately:

- **Blocker** — breaks the no-write promise, grants the run a tool or credential it should not have, weakens trust evaluation, discards human review work, corrupts artifacts on disk, or hand-bumps `version`/cuts a tag.
- **Major** — an unversioned breaking schema change, a non-atomic artifact write, an unvalidated model response, a missing `runner/inflight` claim, a shell-string command built from external input, or a `src/core/` behavior change with no test.
- **Minor** — naming, structure, duplication, a missing graceful-degradation path for something optional.
- **Nit** — formatting and wording. Non-blocking; prefer a follow-up issue over holding a PR.

`changes-requested` needs at least one blocker or major. A pile of minors is an approval with comments.

Report every finding with file and line, the concrete failure scenario, and the reasoning — not just the rule.
