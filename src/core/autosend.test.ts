import { describe, expect, it } from "vitest";
import { Artifact } from "./artifact.js";
import { evaluateAutoSend } from "./autosend.js";
import { computeCalibration } from "./send.js";

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    schemaVersion: 1,
    id: "o/r#1",
    status: "ready",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    pr: {
      owner: "o",
      repo: "r",
      number: 1,
      title: "T",
      url: "u",
      author: "a",
      body: "",
      baseRefName: "main",
      headRefName: "f",
      headSha: "abc",
      state: "OPEN" as const,
      additions: 0,
      deletions: 0,
      changedFiles: 0,
    },
    diff: "",
    summary: "",
    chapters: [],
    comments: [],
    verdict: { recommendation: "approve", confidence: 95, reasoning: "clean" },
    run: null,
    sent: null,
    refresh: null,
    calibration: null,
    ...overrides,
  };
}

describe("evaluateAutoSend", () => {
  it("accepts a high-confidence approve", () => {
    expect(evaluateAutoSend(makeArtifact(), 90).eligible).toBe(true);
  });

  it("rejects below the threshold", () => {
    const a = makeArtifact({ verdict: { recommendation: "approve", confidence: 89, reasoning: "" } });
    const d = evaluateAutoSend(a, 90);
    expect(d.eligible).toBe(false);
    expect(d.reason).toContain("89");
  });

  it("rejects non-approve verdicts regardless of confidence", () => {
    for (const rec of ["comment", "request_changes"] as const) {
      const a = makeArtifact({ verdict: { recommendation: rec, confidence: 99, reasoning: "" } });
      expect(evaluateAutoSend(a, 90).eligible).toBe(false);
    }
  });

  it("rejects already-sent and non-ready artifacts", () => {
    expect(
      evaluateAutoSend(
        makeArtifact({ sent: { at: "x", event: "APPROVE", url: null, auto: false } }),
        90,
      ).eligible,
    ).toBe(false);
    expect(evaluateAutoSend(makeArtifact({ status: "failed" }), 90).eligible).toBe(false);
    expect(evaluateAutoSend(makeArtifact({ verdict: null }), 90).eligible).toBe(false);
  });
});

describe("computeCalibration", () => {
  it("counts AI comment outcomes and user additions", () => {
    const a = makeArtifact({
      comments: [
        { id: "1", path: "f", line: 1, body: "x", chapterId: null, origin: "ai", status: "draft", editedByUser: false, originalLine: null, drifted: false },
        { id: "2", path: "f", line: 2, body: "y", chapterId: null, origin: "ai", status: "dropped", editedByUser: false, originalLine: null, drifted: false },
        { id: "3", path: "f", line: 3, body: "z", chapterId: null, origin: "ai", status: "approved", editedByUser: true, originalLine: null, drifted: false },
        { id: "4", path: "f", line: null, body: "mine", chapterId: null, origin: "user", status: "draft", editedByUser: false, originalLine: null, drifted: false },
      ],
    });
    expect(computeCalibration(a, "COMMENT")).toEqual({
      aiRecommendation: "approve",
      aiConfidence: 95,
      sentEvent: "COMMENT",
      aiCommentsTotal: 3,
      aiCommentsDropped: 1,
      aiCommentsEdited: 1,
      userCommentsAdded: 1,
    });
  });
});
