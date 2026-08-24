import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Mock, beforeEach, describe, expect, it, vi } from "vitest";
import { Artifact, Comment, PrInfo, SCHEMA_VERSION } from "../core/artifact.js";
import { fetchPrDiff, fetchPrInfo } from "../core/gh.js";
import { loadArtifact, saveArtifact, updateArtifactByKey } from "../core/state.js";
import { runClaude } from "./claude.js";
import { reviewPr } from "./review.js";

// What the user did while the run was going is the whole subject here, so the
// run is driven end to end with only `claude` and GitHub stubbed out.
vi.mock("../core/gh.js", async (orig) => ({
  ...(await orig<typeof import("../core/gh.js")>()),
  fetchPrInfo: vi.fn(),
  fetchPrDiff: vi.fn(),
}));
vi.mock("./claude.js", async (orig) => ({
  ...(await orig<typeof import("./claude.js")>()),
  runClaude: vi.fn(),
}));

const prInfo = fetchPrInfo as Mock;
const diff = fetchPrDiff as Mock;
const claude = runClaude as Mock;

process.env.CERBER_HOME = mkdtempSync(path.join(os.tmpdir(), "cerber-merge-"));

const REF = { owner: "acme", repo: "widgets", number: 7 };
const ID = "acme/widgets#7";
const KEY = "acme__widgets__7";

/** One hunk, two context lines — enough for a comment to anchor to by text. */
const DIFF = ["--- a/a.ts", "+++ b/a.ts", "@@ -1,2 +1,2 @@", " const x = 1;", "+const y = 2;"].join("\n");

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

function comment(over: Partial<Comment> = {}): Comment {
  return {
    id: "c1",
    path: "a.ts",
    line: 2,
    body: "I wrote this myself",
    chapterId: null,
    severity: null,
    origin: "user",
    status: "draft",
    editedByUser: false,
    originalLine: null,
    drifted: false,
    ...over,
  };
}

function ready(comments: Comment[], headSha = "old-sha"): Artifact {
  const now = "2026-08-21T10:00:00.000Z";
  return {
    schemaVersion: SCHEMA_VERSION,
    id: ID,
    status: "ready",
    createdAt: now,
    updatedAt: now,
    pr: pr(headSha),
    diff: DIFF,
    summary: "the previous draft",
    chapters: [],
    comments,
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

/** A well-formed AI answer, so the run reaches its success path. */
const AI_ANSWER = JSON.stringify({
  summary: "the new draft",
  chapters: [],
  comments: [{ path: "a.ts", line: 2, body: "the AI's finding", chapterId: null, severity: "minor" }],
  verdict: { recommendation: "approve", confidence: 90, reasoning: "looks fine" },
});

/** Let the caller act on the artifact partway through the run, as a user would. */
function claudeThat(midRun: () => Promise<void>, answer: string | Error = AI_ANSWER) {
  claude.mockImplementation(async () => {
    await midRun();
    if (answer instanceof Error) throw answer;
    return { text: answer, sessionId: null, costUsd: null, model: null };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prInfo.mockResolvedValue(pr("new-sha"));
  diff.mockResolvedValue(DIFF);
});

describe("what a re-review does to the comments you wrote", () => {
  it("keeps them when the run fails", async () => {
    // They used to be dropped to `comments: []` before the run and put back
    // only on the success path, so any failure — a model error, a lost
    // connection — took the user's own writing with it, permanently.
    await saveArtifact(ready([comment()]));
    claudeThat(async () => {}, new Error("model unavailable"));

    await expect(reviewPr(REF, { withSource: false })).rejects.toThrow("model unavailable");

    const after = (await loadArtifact(ID))!;
    expect(after.status).toBe("failed");
    expect(after.comments.map((c) => c.body)).toEqual(["I wrote this myself"]);
  });

  it("keeps them on disk for the whole run, not just at the end", async () => {
    // The guarantee has to hold at every instant, because a crash can land at
    // any of them. Reading the artifact mid-run is how we check that.
    await saveArtifact(ready([comment()]));
    let midRun: Artifact | null = null;
    claudeThat(async () => {
      midRun = await loadArtifact(ID);
    });

    await reviewPr(REF, { withSource: false });
    expect(midRun!.status).toBe("running");
    expect(midRun!.comments.map((c) => c.body)).toEqual(["I wrote this myself"]);
  });

  it("takes the version you edited while it ran, not the one it read", async () => {
    await saveArtifact(ready([comment()]));
    claudeThat(async () => {
      await updateArtifactByKey(KEY, (a) => ({
        ...a,
        comments: a.comments.map((c) => ({ ...c, body: "edited while it ran" })),
      }));
    });

    const { artifact } = await reviewPr(REF, { withSource: false });
    expect(artifact.comments.map((c) => c.body).sort()).toEqual([
      "edited while it ran",
      "the AI's finding",
    ]);
  });

  it("keeps one you added while it ran", async () => {
    await saveArtifact(ready([]));
    claudeThat(async () => {
      await updateArtifactByKey(KEY, (a) => ({
        ...a,
        comments: [...a.comments, comment({ id: "added-mid-run", body: "added while it ran" })],
      }));
    });

    const { artifact } = await reviewPr(REF, { withSource: false });
    expect(artifact.comments.map((c) => c.body).sort()).toEqual([
      "added while it ran",
      "the AI's finding",
    ]);
  });

  it("leaves one you deleted while it ran deleted", async () => {
    // The mirror of the case above, and the reason the merge reads the disk
    // rather than replaying what the run started from: resurrecting a comment
    // the user deleted is the same class of mistake as losing one they wrote.
    await saveArtifact(ready([comment()]));
    claudeThat(async () => {
      await updateArtifactByKey(KEY, (a) => ({ ...a, comments: [] }));
    });

    const { artifact } = await reviewPr(REF, { withSource: false });
    expect(artifact.comments.map((c) => c.body)).toEqual(["the AI's finding"]);
  });

  it("regenerates the AI's own comments rather than accumulating them", async () => {
    await saveArtifact(ready([comment({ id: "old-ai", origin: "ai", body: "a stale AI finding" })]));
    claudeThat(async () => {});

    const { artifact } = await reviewPr(REF, { withSource: false });
    expect(artifact.comments.map((c) => c.body)).toEqual(["the AI's finding"]);
  });
});

describe("what a re-review does to a decision you made while it ran", () => {
  it("does not undo a send", async () => {
    // The run used to write its own `sent: null` over the record, after which
    // the send path's "already sent" guard would wave a second submission
    // through — one click, two reviews on the PR.
    await saveArtifact(ready([]));
    const sent = { at: "2026-08-21T10:02:00.000Z", event: "APPROVE" as const, url: "u", auto: false };
    claudeThat(async () => {
      await updateArtifactByKey(KEY, (a) => ({ ...a, status: "sent" as const, sent }));
    });

    const { artifact } = await reviewPr(REF, { withSource: false });
    expect(artifact.sent).toEqual(sent);
    expect(artifact.status).toBe("sent");
    // And the fresh draft still landed underneath it.
    expect(artifact.summary).toBe("the new draft");
  });

  it("does not reopen one you settled", async () => {
    for (const status of ["reviewed", "skipped"] as const) {
      await saveArtifact(ready([]));
      claudeThat(async () => {
        await updateArtifactByKey(KEY, (a) => ({ ...a, status }));
      });

      const { artifact } = await reviewPr(REF, { withSource: false });
      expect(artifact.status).toBe(status);
      expect(artifact.summary).toBe("the new draft");
    }
  });

  it("does not reopen one you settled when the run fails either", async () => {
    // A failure is still just a fact about the code; it does not overrule a
    // decision about the PR any more than a success does.
    await saveArtifact(ready([]));
    claudeThat(async () => {
      await updateArtifactByKey(KEY, (a) => ({ ...a, status: "skipped" as const }));
    }, new Error("model unavailable"));

    await expect(reviewPr(REF, { withSource: false })).rejects.toThrow("model unavailable");

    const after = (await loadArtifact(ID))!;
    expect(after.status).toBe("skipped");
    // The error is still recorded, so the row can say what happened.
    expect(after.run?.error).toMatch(/model unavailable/);
  });

  it("records the head it actually read", async () => {
    await saveArtifact(ready([]));
    claudeThat(async () => {});

    const { artifact } = await reviewPr(REF, { withSource: false });
    expect(artifact.run?.reviewedSha).toBe("new-sha");
  });
});
