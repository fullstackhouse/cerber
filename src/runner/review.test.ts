import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Mock, beforeEach, describe, expect, it, vi } from "vitest";
import { Artifact, ArtifactStatus, PrInfo, SCHEMA_VERSION } from "../core/artifact.js";
import { fetchPrDiff, fetchPrInfo } from "../core/gh.js";
import { saveArtifact } from "../core/state.js";
import { reviewPr } from "./review.js";

// Only the freshness gate is under test: whether a run happens at all. Every
// path that gets past it fetches the diff first, so an untouched `fetchPrDiff`
// is the proof nothing ran — no `claude`, no checkout, no minutes of waiting.
vi.mock("../core/gh.js", async (orig) => ({
  ...(await orig<typeof import("../core/gh.js")>()),
  fetchPrInfo: vi.fn(),
  fetchPrDiff: vi.fn(),
}));

const prInfo = fetchPrInfo as Mock;
const diff = fetchPrDiff as Mock;

process.env.CERBER_HOME = mkdtempSync(path.join(os.tmpdir(), "cerber-freshness-"));

const REF = { owner: "acme", repo: "widgets", number: 7 };

function pr(headSha: string): PrInfo {
  return {
    ...REF,
    title: "feat: add sprockets",
    url: "https://github.com/acme/widgets/pull/7",
    author: "someone",
    body: "",
    baseRefName: "main",
    headRefName: "feature",
    headSha,
    state: "OPEN",
    isDraft: false,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
  };
}

function artifact(status: ArtifactStatus, headSha: string): Artifact {
  const now = "2026-08-21T10:00:00.000Z";
  return {
    schemaVersion: SCHEMA_VERSION,
    id: "acme/widgets#7",
    status,
    createdAt: now,
    updatedAt: now,
    pr: pr(headSha),
    diff: "--- a\n+++ b\n",
    summary: "it does a thing",
    chapters: [],
    comments: [],
    verdict: null,
    run: null,
    sent: null,
    filed: null,
    refresh: null,
    calibration: null,
    chat: [],
    preChat: null,
    pendingChat: null,
  };
}

/** A finished run, for the cases that turn on what it recorded. */
const runBlock = {
  model: null,
  startedAt: "2026-08-21T10:00:00.000Z",
  finishedAt: "2026-08-21T10:05:00.000Z",
  costUsd: null,
  error: null,
  withSource: false,
  trusted: false,
  sessionId: null,
  trigger: "daemon" as const,
  reviewedSha: null as string | null,
};

beforeEach(() => {
  vi.clearAllMocks();
  diff.mockRejectedValue(new Error("a run started when it should not have"));
});

describe("what a new push does to a review", () => {
  it("re-reviews a draft nobody has acted on", async () => {
    await saveArtifact(artifact("ready", "old-sha"));
    prInfo.mockResolvedValue(pr("new-sha"));
    // The run itself is out of scope — reaching the diff fetch is the assertion.
    await expect(reviewPr(REF)).rejects.toThrow("a run started when it should not have");
    expect(diff).toHaveBeenCalled();
  });

  it("leaves a review you marked reviewed or skipped alone", async () => {
    // Your decision is about this PR, not about a commit range. The author
    // pushing again is not you changing your mind — and on a busy PR it happens
    // every few minutes, which used to drag the row back into the inbox each time.
    for (const status of ["reviewed", "skipped"] as const) {
      await saveArtifact(artifact(status, "old-sha"));
      prInfo.mockResolvedValue(pr("new-sha"));

      const result = await reviewPr(REF);
      expect(result.skipped).toBe(true);
      expect(result.artifact.status).toBe(status);
      expect(diff).not.toHaveBeenCalled();
    }
  });

  it("still lets you ask for a fresh draft yourself", async () => {
    // The cockpit's re-review button forces, which is the way back in — a
    // sticky mark you could not undo would be a worse bug than the one it fixes.
    await saveArtifact(artifact("skipped", "old-sha"));
    prInfo.mockResolvedValue(pr("new-sha"));

    await expect(reviewPr(REF, { force: true })).rejects.toThrow(
      "a run started when it should not have",
    );
    expect(diff).toHaveBeenCalled();
  });

  it("skips an untouched draft while the head has not moved", async () => {
    await saveArtifact(artifact("ready", "same-sha"));
    prInfo.mockResolvedValue(pr("same-sha"));

    const result = await reviewPr(REF);
    expect(result.skipped).toBe(true);
    expect(diff).not.toHaveBeenCalled();
  });

  it("still re-reviews a draft you opened after the push", async () => {
    // Opening a review refreshes it, which moves `pr.headSha` onto the new head
    // so the comments stay anchored to current code. Nothing was re-read, and
    // the guard used to compare against that field — so merely looking at a
    // draft convinced it the draft was current, and the poll never re-reviewed
    // that PR again. It compares against the sha the AI actually read instead.
    await saveArtifact({
      ...artifact("ready", "new-sha"),
      run: { ...runBlock, reviewedSha: "old-sha" },
      refresh: { at: "2026-08-21T11:00:00.000Z", fromSha: "old-sha", toSha: "new-sha", moved: 1, drifted: 0 },
    });
    prInfo.mockResolvedValue(pr("new-sha"));

    await expect(reviewPr(REF)).rejects.toThrow("a run started when it should not have");
    expect(diff).toHaveBeenCalled();
  });

  it("skips one whose recorded review is of this very head", async () => {
    await saveArtifact({
      ...artifact("ready", "same-sha"),
      run: { ...runBlock, reviewedSha: "same-sha" },
    });
    prInfo.mockResolvedValue(pr("same-sha"));

    const result = await reviewPr(REF);
    expect(result.skipped).toBe(true);
    expect(diff).not.toHaveBeenCalled();
  });

  it("re-reviews a sent one when the author pushes and asks again", async () => {
    // A submitted review clears GitHub's request, so a fresh one only ever
    // arrives because someone asked for another look. That is when a new draft
    // is the whole point.
    await saveArtifact(artifact("sent", "old-sha"));
    prInfo.mockResolvedValue(pr("new-sha"));

    await expect(reviewPr(REF)).rejects.toThrow("a run started when it should not have");
    expect(diff).toHaveBeenCalled();
  });
});
