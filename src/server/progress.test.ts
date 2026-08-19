import { describe, expect, it, vi } from "vitest";
import { Artifact } from "../core/artifact.js";
import { progressWriter } from "./progress.js";

/** A stand-in artifact store: same read-modify-write shape, no disk. */
function store(initial: Partial<Artifact["pendingChat"]> | null = { message: "why?", refs: [], startedAt: "t", progress: [], error: null }) {
  let artifact = { pendingChat: initial } as Artifact;
  const writes: string[][] = [];
  const update = vi.fn(async (_key: string, mutate: (a: Artifact) => Artifact) => {
    artifact = mutate(artifact);
    writes.push(artifact.pendingChat?.progress ?? []);
    return artifact;
  });
  return { update: update as never, writes, get: () => artifact };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("progressWriter", () => {
  it("coalesces a burst into one write, rather than rewriting the artifact per line", async () => {
    // The artifact carries the whole diff; a write per tool call would rewrite
    // it dozens of times to show what one poll would have shown anyway.
    const s = store();
    const w = progressWriter("k", { everyMs: 5, update: s.update });
    w.push("reading a.ts");
    w.push("reading b.ts");
    w.push("running pnpm test");
    await w.stop();
    expect(s.writes).toHaveLength(1);
    expect(s.get().pendingChat?.progress).toEqual(["reading a.ts", "reading b.ts", "running pnpm test"]);
  });

  it("drops a repeated line — 'thinking…' arrives over and over", async () => {
    const s = store();
    const w = progressWriter("k", { everyMs: 5, update: s.update });
    w.push("thinking…");
    w.push("thinking…");
    w.push("reading a.ts");
    w.push("thinking…");
    await w.stop();
    expect(s.get().pendingChat?.progress).toEqual(["thinking…", "reading a.ts", "thinking…"]);
  });

  it("keeps only the recent lines, so a long turn can't grow without bound", async () => {
    const s = store();
    const w = progressWriter("k", { everyMs: 5, keep: 3, update: s.update });
    for (let i = 0; i < 10; i++) w.push(`line ${i}`);
    await w.stop();
    expect(s.get().pendingChat?.progress).toEqual(["line 7", "line 8", "line 9"]);
  });

  it("writes nothing once the turn has landed", async () => {
    // The answer clears pendingChat; a late append must not resurrect it.
    const s = store(null);
    const w = progressWriter("k", { everyMs: 1, update: s.update });
    w.push("reading a.ts");
    await w.stop();
    expect(s.get().pendingChat).toBeNull();
  });

  it("refuses anything pushed after stop, so nothing writes behind the answer", async () => {
    // stop() is awaited before the result is saved. A write that started after
    // it would read the pre-answer artifact and write it back over the answer.
    const s = store();
    const w = progressWriter("k", { everyMs: 1, update: s.update });
    await w.stop();
    w.push("too late");
    await tick();
    await tick();
    expect(s.update).not.toHaveBeenCalled();
  });

  it("flushes what it had when it stops — the last thing a failed turn did", async () => {
    const s = store();
    const w = progressWriter("k", { everyMs: 60_000, update: s.update });
    w.push("running pnpm test");
    await w.stop();
    expect(s.get().pendingChat?.progress).toEqual(["running pnpm test"]);
  });

  it("keeps going when a write fails — a lost line is not a lost turn", async () => {
    const update = vi.fn().mockRejectedValue(new Error("disk full"));
    const w = progressWriter("k", { everyMs: 1, update: update as never });
    w.push("reading a.ts");
    await expect(w.stop()).resolves.toBeUndefined();
  });
});
