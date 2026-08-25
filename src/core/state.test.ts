import { mkdtempSync, promises as fs, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Artifact, SCHEMA_VERSION } from "./artifact.js";

const home = mkdtempSync(path.join(os.tmpdir(), "cerber-state-"));
process.env.CERBER_HOME = home;

const { loadArtifact, noteHistory, reconcileRunning, saveArtifact, updateArtifactByKey } =
  await import("./state.js");
const { MAX_ENTRIES, withWriter } = await import("./history.js");

function artifact(over: Partial<Artifact> = {}): Artifact {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: "acme/widgets#42",
    status: "ready",
    createdAt: "2026-08-19T00:00:00Z",
    updatedAt: "2026-08-19T00:00:00Z",
    pr: {
      owner: "acme",
      repo: "widgets",
      number: 42,
      title: "Add a thing",
      url: "u",
      author: "someone",
      body: "",
      baseRefName: "main",
      headRefName: "f",
      headSha: "abc",
      state: "OPEN",
      isDraft: false,
      additions: 1,
      deletions: 0,
      changedFiles: 1,
    },
    diff: "diff",
    summary: "s",
    chapters: [],
    comments: [],
    verdict: null,
    run: null,
    sent: null,
    refresh: null,
    filed: null,
    calibration: null,
    chat: [],
    preChat: null,
    pendingChat: null,
    ...over,
  };
}

beforeEach(async () => {
  await fs.rm(path.join(home, "reviews"), { recursive: true, force: true });
});

describe("reconcileRunning", () => {
  it("fails a review left mid-run by a process that died", async () => {
    await saveArtifact(
      artifact({
        status: "running",
        run: {
          model: null,
          startedAt: "t",
          finishedAt: null,
          costUsd: null,
          error: null,
          withSource: true,
          trusted: false,
          sessionId: null,
          trigger: null,
          reviewedSha: null,
        },
      }),
    );
    expect(await reconcileRunning()).toBe(1);
    const after = await loadArtifact("acme/widgets#42");
    expect(after?.status).toBe("failed");
    expect(after?.run?.error).toMatch(/interrupted/);
  });

  it("marks a chat turn that died with the process, rather than leaving it pending forever", async () => {
    // A turn runs detached, so nothing is left to answer it after a restart —
    // without this the cockpit polls a question that will never land.
    await saveArtifact(
      artifact({ pendingChat: { message: "why?", refs: [], startedAt: "t", progress: [], error: null } }),
    );
    expect(await reconcileRunning()).toBe(1);
    const after = await loadArtifact("acme/widgets#42");
    expect(after?.status).toBe("ready");
    expect(after?.pendingChat?.message).toBe("why?");
    expect(after?.pendingChat?.error).toMatch(/interrupted/);
  });

  it("leaves a run this process actually owns alone", async () => {
    // `serve` reconciles before it starts anything that polls, but ordering is
    // a promise about wiring and this is the guard that holds regardless: a
    // reconciliation racing a daemon's first tick must not stamp "interrupted"
    // over a review that has just legitimately begun.
    await saveArtifact(
      artifact({
        status: "running",
        run: {
          model: null,
          startedAt: "t",
          finishedAt: null,
          costUsd: null,
          error: null,
          withSource: true,
          trusted: false,
          sessionId: null,
          trigger: "daemon",
          reviewedSha: null,
        },
      }),
    );

    expect(await reconcileRunning({ inUse: (id) => id === "acme/widgets#42" })).toBe(0);
    const after = await loadArtifact("acme/widgets#42");
    expect(after?.status).toBe("running");
    expect(after?.run?.error).toBeNull();
  });

  it("leaves a turn that already failed, and everything else, alone", async () => {
    await saveArtifact(
      artifact({ pendingChat: { message: "why?", refs: [], startedAt: "t", progress: [], error: "boom" } }),
    );
    expect(await reconcileRunning()).toBe(0);
    expect((await loadArtifact("acme/widgets#42"))?.pendingChat?.error).toBe("boom");
  });
});

describe("the history every write keeps", () => {
  const id = "acme/widgets#42";
  const key = "acme__widgets__42";
  const whatHappened = async () => (await loadArtifact(id))?.history?.map((e) => e.what) ?? [];

  it("keeps the log across a write that overwrites the artifact wholesale", async () => {
    await saveArtifact(artifact({ status: "awaiting" }));
    // What a re-review does: hand over an artifact built minutes ago, whose own
    // copy of the history is empty. Disk is the only source, so nothing is lost.
    await saveArtifact(artifact({ status: "ready" }));
    await saveArtifact(artifact({ status: "sent" }));
    expect(await whatHappened()).toEqual([
      "appeared in the inbox — GitHub is asking you for a review",
      "status awaiting → ready",
      "status ready → sent",
    ]);
  });

  it("ignores a history handed in by the caller", async () => {
    await saveArtifact(artifact({ status: "ready" }));
    await saveArtifact(
      artifact({
        status: "skipped",
        history: [{ at: "1999-01-01T00:00:00Z", by: "cli", what: "invented", cause: null }],
      }),
    );
    expect(await whatHappened()).toEqual(["first written here (ready)", "status ready → skipped"]);
  });

  it("keeps an entry another writer landed between the read and the write", async () => {
    await saveArtifact(artifact({ status: "ready" }));
    const file = path.join(home, "reviews", `${key}.json`);

    await updateArtifactByKey(key, (a) => {
      // The poll lands a note in the window between the load this mutation was
      // handed and the save that follows it — the race two writers on one file
      // genuinely have. Appending to the copy in hand would drop it.
      const theirs = JSON.parse(readFileSync(file, "utf8"));
      theirs.history.push({
        at: "2026-08-24T14:45:00Z",
        by: "daemon",
        what: "left alone: you marked it skipped",
        cause: "poll",
      });
      writeFileSync(file, JSON.stringify(theirs));
      return { ...a, status: "skipped" as const };
    });

    expect(await whatHappened()).toEqual([
      "first written here (ready)",
      "left alone: you marked it skipped",
      "status ready → skipped",
    ]);
  });

  it("names which part of cerber made the change", async () => {
    await saveArtifact(artifact({ status: "ready" }));
    await withWriter({ by: "cockpit", cause: "PATCH /api/reviews/x" }, () =>
      updateArtifactByKey(key, (a) => ({ ...a, status: "skipped" as const })),
    );
    const entry = (await loadArtifact(id))?.history?.at(-1);
    expect(entry).toMatchObject({ by: "cockpit", cause: "PATCH /api/reviews/x" });
  });

  it("records a decision that changed nothing, without disturbing the queue's order", async () => {
    await saveArtifact(artifact({ status: "skipped", updatedAt: "2026-08-19T00:00:00Z" }));
    const note = "left alone: you marked it skipped, so a new push does not reopen it";
    await noteHistory(id, note);
    await noteHistory(id, note);

    const after = await loadArtifact(id);
    expect(after?.history?.map((e) => e.what)).toEqual(["first written here (skipped)", note]);
    // A note is not a change to the review: it must not float the row to the
    // top of a queue sorted by updatedAt.
    expect(after?.updatedAt).toBe("2026-08-19T00:00:00Z");

    // And the repeat cost nothing: a note with nothing to add doesn't rewrite
    // an artifact that carries a whole diff.
    const file = path.join(home, "reviews", `${key}.json`);
    const written = (await fs.stat(file)).mtimeMs;
    await noteHistory(id, note);
    expect((await fs.stat(file)).mtimeMs).toBe(written);
  });

  it("still records a note when the log is already at its cap", async () => {
    await saveArtifact(artifact({ status: "skipped" }));
    const file = path.join(home, "reviews", `${key}.json`);
    const seeded = JSON.parse(readFileSync(file, "utf8"));
    seeded.history = Array.from({ length: MAX_ENTRIES }, (_, i) => ({
      at: "2026-08-24T11:07:00Z",
      by: "daemon",
      what: `entry ${i}`,
      cause: null,
    }));
    writeFileSync(file, JSON.stringify(seeded));

    const note = "left alone: you marked it skipped";
    await noteHistory(id, note);

    // At the cap, appending trims an older entry — so the log is the same
    // length either way, and a caller reading that as "nothing was added"
    // would leave a full row unable to record another decision, ever.
    const after = await loadArtifact(id);
    expect(after?.history).toHaveLength(MAX_ENTRIES);
    expect(after?.history?.at(-1)?.what).toBe(note);
  });

  it("says so rather than starting over quietly, when the file on disk is broken", async () => {
    await saveArtifact(artifact({ status: "ready" }));
    await fs.writeFile(path.join(home, "reviews", `${key}.json`), "{ not json");
    await saveArtifact(artifact({ status: "skipped" }));
    expect(await whatHappened()).toEqual([
      "history restarts here — the previous file could not be read",
    ]);
  });
});
