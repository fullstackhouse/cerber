import { Artifact } from "../core/artifact.js";
import { updateArtifactByKey } from "../core/state.js";

/**
 * Putting a running turn's narration where the cockpit can see it.
 *
 * The turn is detached, so there is no connection to stream down: the artifact
 * is the channel, exactly as it is for the pending question itself. That keeps
 * the story on a reload and behind a proxy, and costs no new transport.
 *
 * Two things it must not do. It must not rewrite the whole artifact — diff and
 * all — once per line, so lines are coalesced into one write every couple of
 * seconds, which is as often as the cockpit polls anyway. And it must not still
 * be writing when the turn lands: an append that read the artifact before the
 * answer was folded in would write back the "still thinking" version on top of
 * it. `stop()` is awaited before the result is saved, and refuses every append
 * after that.
 */

/** Enough to see what it has been up to, not so much that the panel scrolls away. */
const KEEP = 30;

export interface ProgressWriter {
  /** Record a line. Consecutive duplicates are dropped — "thinking…" repeats. */
  push(line: string): void;
  /** Flush what's queued and refuse anything further. Await before saving the result. */
  stop(): Promise<void>;
}

export function progressWriter(
  key: string,
  opts: { everyMs?: number; keep?: number; update?: typeof updateArtifactByKey } = {},
): ProgressWriter {
  const everyMs = opts.everyMs ?? 2_000;
  const keep = opts.keep ?? KEEP;
  const update = opts.update ?? updateArtifactByKey;

  let queued: string[] = [];
  let last: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  // Writes chain onto each other so two flushes can never interleave their
  // read-modify-write, and so stop() has something to await.
  let writes: Promise<unknown> = Promise.resolve();

  const flush = () => {
    timer = null;
    const lines = queued;
    queued = [];
    if (!lines.length) return;
    writes = writes.then(() =>
      update(key, (a: Artifact) =>
        // No pending turn means it already landed (or was dismissed) — there is
        // nothing left for this narration to describe.
        a.pendingChat
          ? {
              ...a,
              pendingChat: {
                ...a.pendingChat,
                progress: [...a.pendingChat.progress, ...lines].slice(-keep),
              },
            }
          : a,
      ).catch(() => {
        // A line that never reaches disk is a line the user doesn't see. The
        // turn itself is unaffected, so it is not worth failing over.
      }),
    );
  };

  return {
    push(line: string) {
      if (stopped || !line || line === last) return;
      last = line;
      queued.push(line);
      if (!timer) timer = setTimeout(flush, everyMs);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      // Flush what's left rather than dropping it: on the failure path the
      // pending turn survives, and the last thing it did before dying is
      // exactly what the user wants to see.
      flush();
      await writes;
    },
  };
}
