# Contributing

Cerber is maintained by [Full Stack House](https://fullstack.house). Issues, bug
reports and pull requests are welcome; so is being told the tool is wrong about
something.

**What this project does not promise:** a response time, a roadmap, or that a
feature request will be built. It is a tool we use every day and publish because
it is useful, not a product with a support contract behind it.

## Before you open a PR

```bash
pnpm install
pnpm typecheck      # tsc over src/ and web/
pnpm test           # vitest, colocated *.test.ts
pnpm dev doctor     # the same preflight a user gets
```

`pnpm typecheck && pnpm test` is the gate. Both must pass; CI runs them again.

To drive the cockpit without a GitHub token, a Claude subscription or a network —
useful for working on the UI, and for trying the Send button without sending
anything — run [`demo/run.sh`](./demo/README.md).

- **Tests live next to the code** (`src/core/foo.ts` → `src/core/foo.test.ts`), and
  a change to behaviour comes with one that fails without it.
- **Conventional commits** — `feat:`, `fix:`, `docs:`, `refactor:`, `test:`,
  `chore:`. Releases are cut by semantic-release from these, so the prefix
  decides the version bump. Use `feat!:` for a breaking change.
- **Read [`SPEC.md`](./SPEC.md) before changing behaviour.** It is the design of
  record, with an appendix listing where the code has diverged from it. If your
  change moves that line, move the spec in the same PR.
- **The hard rule is not negotiable:** the only code path that writes to GitHub
  is a human-initiated send (`src/core/send.ts`), plus the auto-send a user turns
  on themselves. A PR that lets anything else post — a poll, a retry, a
  convenience — will not be merged, however good the reason.

`SDLC.md` and `CODE_REVIEW.md` describe how *we* work on this repo, with our own
agent tooling. They are published for transparency, not as requirements: nothing
in them is needed to send a patch.

## Reporting a bug

Say what you ran, what you expected, what happened. `cerber doctor` output and
the relevant part of `cerber history <pr>` are usually the two things that make a
report answerable. Please don't paste artifacts containing code you can't share —
they hold the diff under review.
