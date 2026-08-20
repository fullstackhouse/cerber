import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Artifact, SCHEMA_VERSION } from "./artifact.js";

const home = mkdtempSync(path.join(os.tmpdir(), "cerber-state-"));
process.env.CERBER_HOME = home;

const { loadArtifact, reconcileRunning, saveArtifact } = await import("./state.js");

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

  it("leaves a turn that already failed, and everything else, alone", async () => {
    await saveArtifact(
      artifact({ pendingChat: { message: "why?", refs: [], startedAt: "t", progress: [], error: "boom" } }),
    );
    expect(await reconcileRunning()).toBe(0);
    expect((await loadArtifact("acme/widgets#42"))?.pendingChat?.error).toBe("boom");
  });
});
