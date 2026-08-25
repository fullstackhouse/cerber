import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Artifact, ArtifactSchema, artifactKey } from "./artifact.js";
import { appendHistory, noteIsRepeat } from "./history.js";

export function cerberHome(): string {
  return process.env.CERBER_HOME ?? path.join(os.homedir(), ".cerber");
}

function reviewsDir(): string {
  return path.join(cerberHome(), "reviews");
}

function artifactPath(id: string): string {
  return path.join(reviewsDir(), `${artifactKey(id)}.json`);
}

/**
 * Read whatever is on disk, tolerating anything.
 *
 * These files are the user's to edit, so a broken one has to be survivable:
 * before, a save simply overwrote it. It still does — but the timeline says so
 * rather than quietly claiming the review began at that moment.
 */
async function readPrior(file: string): Promise<{ artifact: Artifact | null; unreadable: boolean }> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { artifact: null, unreadable: false };
    return { artifact: null, unreadable: true };
  }
  try {
    return { artifact: ArtifactSchema.parse(JSON.parse(raw)), unreadable: false };
  } catch {
    return { artifact: null, unreadable: true };
  }
}

/**
 * Write an artifact, and record what changed about it.
 *
 * The history is appended here rather than by the caller on purpose. Around
 * twenty places write artifacts and several of them overwrite one wholesale
 * from a copy built minutes earlier — a log any of them had to remember to
 * carry would be lost by the first one that didn't. Appending at the one place
 * every write goes through makes the record a property of writing.
 *
 * The read here is not skippable, even for a caller that has just done one of
 * its own. Two writers share these files — the poll's timer and the cockpit's
 * button — so a caller's copy can be out of date by the time it writes, and
 * appending to *that* would drop whatever the other one recorded in between.
 * The rest of the artifact is lost in that race either way; the history need
 * not be, and the extra read is one file next to a write of the same file.
 *
 * `note` records a decision that changed nothing, which is the only kind of
 * history a diff cannot see. It does not touch `updatedAt` — that belongs to
 * `updateArtifactByKey`.
 */
export async function saveArtifact(
  artifact: Artifact,
  opts: { note?: string } = {},
): Promise<string> {
  await fs.mkdir(reviewsDir(), { recursive: true });
  const file = artifactPath(artifact.id);
  const prior = await readPrior(file);
  const next: Artifact = {
    ...artifact,
    history: appendHistory(prior.artifact, artifact, {
      note: opts.note,
      unreadable: prior.unreadable,
    }),
  };
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2));
  await fs.rename(tmp, file);
  return file;
}

/**
 * Write down a decision that changed nothing.
 *
 * The poll's silences are the hardest thing to debug about it — it looks at a
 * settled row, decides deliberately to leave it alone, and leaves no trace of
 * having looked. This is that trace. It is not a change to the review, so
 * `updatedAt` stays put: a note must not reorder the queue.
 *
 * Missing artifacts are ignored, and a note identical to the last entry is
 * dropped, so a decision re-taken every poll is recorded once.
 */
export async function noteHistory(id: string, what: string): Promise<void> {
  const prior = await loadArtifact(id).catch(() => null);
  if (!prior) return;
  // Nothing to add means nothing to write: the poll re-takes these decisions
  // every few minutes, and rewriting a whole artifact, diff and all, to change
  // nothing is the expensive half of saying it again. The rule for "nothing to
  // add" is `appendHistory`'s, so ask it rather than knowing it twice — and ask
  // it directly, because at the cap an appended note trims an older entry and
  // leaves the length exactly as it was.
  if (noteIsRepeat(prior, what)) return;
  await saveArtifact(prior, { note: what });
}

export async function loadArtifact(id: string): Promise<Artifact | null> {
  try {
    const raw = await fs.readFile(artifactPath(id), "utf8");
    return ArtifactSchema.parse(JSON.parse(raw));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function loadArtifactByKey(key: string): Promise<Artifact | null> {
  try {
    const raw = await fs.readFile(path.join(reviewsDir(), `${key}.json`), "utf8");
    return ArtifactSchema.parse(JSON.parse(raw));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export interface AutoSendLogEntry {
  at: string;
  id: string;
  recommendation: string | null;
  confidence: number | null;
  mode: "shadow" | "on";
  decision: string;
  sent: boolean;
}

/** Append to ~/.cerber/autosend.ndjson — the shadow/auto-send audit log. */
export async function appendAutoSendLog(entry: AutoSendLogEntry): Promise<void> {
  await fs.mkdir(cerberHome(), { recursive: true });
  await fs.appendFile(path.join(cerberHome(), "autosend.ndjson"), JSON.stringify(entry) + "\n");
}

export async function readAutoSendLog(): Promise<AutoSendLogEntry[]> {
  try {
    const raw = await fs.readFile(path.join(cerberHome(), "autosend.ndjson"), "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as AutoSendLogEntry];
        } catch {
          return [];
        }
      });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Remove an artifact file. Only ever called on pure discovery stubs (status
 * "awaiting", no comments) — anything a human or an AI run touched stays.
 */
export async function deleteArtifact(id: string): Promise<boolean> {
  try {
    await fs.unlink(artifactPath(id));
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** Load by key, apply a mutation, bump updatedAt, save. Returns the new artifact. */
export async function updateArtifactByKey(
  key: string,
  mutate: (artifact: Artifact) => Artifact,
): Promise<Artifact | null> {
  const artifact = await loadArtifactByKey(key);
  if (!artifact) return null;
  const updated = { ...mutate(artifact), updatedAt: new Date().toISOString() };
  await saveArtifact(updated);
  return updated;
}

/**
 * Clear AI work left in flight by a process that died mid-run — a review marked
 * "running", or a chat turn still waiting for its answer. Nothing in a freshly
 * started process is running, so anything still marked so is a leftover; without
 * this it stays wedged forever, with no way to retry it from the cockpit. A
 * `cerber review` running in another terminal is the one false positive; it
 * overwrites the artifact when it finishes anyway.
 *
 * `inUse` names the runs this process genuinely owns, and they are left alone.
 * Callers should still reconcile before starting anything that polls — but
 * ordering alone is a promise about wiring, and this is the guard that holds
 * whatever order they are started in: without it, reconciliation racing a
 * daemon's first tick could stamp "interrupted" over a review that had just
 * legitimately begun.
 */
export async function reconcileRunning(
  opts: { inUse?: (id: string) => boolean } = {},
): Promise<number> {
  const inUse = opts.inUse ?? (() => false);
  const artifacts = await listArtifacts();
  let cleared = 0;
  for (const artifact of artifacts) {
    if (inUse(artifact.id)) continue;
    const stuckRun = artifact.status === "running";
    const stuckChat =
      artifact.pendingChat && artifact.pendingChat.error == null ? artifact.pendingChat : null;
    if (!stuckRun && !stuckChat) continue;
    await saveArtifact({
      ...artifact,
      status: stuckRun ? "failed" : artifact.status,
      updatedAt: new Date().toISOString(),
      run:
        stuckRun && artifact.run
          ? { ...artifact.run, error: "interrupted — cerber restarted while this review was running" }
          : artifact.run,
      pendingChat: stuckChat
        ? { ...stuckChat, error: "interrupted — cerber restarted while this turn was running" }
        : artifact.pendingChat,
    });
    cleared++;
  }
  return cleared;
}

export async function listArtifacts(): Promise<Artifact[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(reviewsDir());
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const artifacts: Artifact[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(reviewsDir(), entry), "utf8");
      artifacts.push(ArtifactSchema.parse(JSON.parse(raw)));
    } catch {
      // Skip corrupt files rather than breaking the whole listing.
    }
  }
  artifacts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return artifacts;
}
