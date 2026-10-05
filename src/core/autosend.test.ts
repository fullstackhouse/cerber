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
      isDraft: false,
      additions: 0,
      deletions: 0,
      changedFiles: 0,
    },
    diff: "",
    summary: "",
    chapters: [],
    comments: [],
    verdict: { recommendation: "approve", confidence: 95, reasoning: "clean" },
    bodyOverride: null,
    run: null,
    sent: null,
    refresh: null,
    filed: null,
    handoff: null,
    // A finished, clean check — what every fresh run leaves behind.
    raisedCheck: { at: "2026-01-01T00:00:00Z", checkingSince: null, remarks: [], findings: [], error: null },
    settledAt: null,
    calibration: null,
  chat: [],
  preChat: null,
  pendingChat: null,
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

  it("rejects an approve that still has a live blocker finding", () => {
    const finding = {
      id: "1", path: "f", line: 1, body: "broken", chapterId: null,
      severity: "blocker" as const, origin: "ai" as const, status: "draft" as const,
      editedByUser: false, originalLine: null, drifted: false, alreadyRaised: null,
    };
    const d = evaluateAutoSend(makeArtifact({ comments: [finding] }), 90);
    expect(d.eligible).toBe(false);
    expect(d.reason).toContain("blocker");
  });

  it("still accepts an approve whose blocker was dropped, and one with only minors and nits", () => {
    const c = (severity: "blocker" | "minor" | "nit", status: "draft" | "dropped") => ({
      id: severity, path: "f", line: 1, body: "x", chapterId: null,
      severity, origin: "ai" as const, status, editedByUser: false,
      originalLine: null, drifted: false, alreadyRaised: null,
    });
    expect(
      evaluateAutoSend(makeArtifact({ comments: [c("blocker", "dropped")] }), 90).eligible,
    ).toBe(true);
    expect(
      evaluateAutoSend(makeArtifact({ comments: [c("minor", "draft"), c("nit", "draft")] }), 90)
        .eligible,
    ).toBe(true);
  });

  it("leaves out a duplicate nobody decided about, and says so in the log line", () => {
    const dup = {
      id: "1", path: "f", line: 1, body: "repeat", chapterId: null,
      severity: "minor" as const, origin: "ai" as const, status: "draft" as const,
      editedByUser: false, originalLine: null, drifted: false,
      alreadyRaised: {
        remarkId: "T_1", by: "someone", at: "x", url: null, reason: "same",
        where: { kind: "thread" as const, path: "f", line: 1, state: "open" as const, replyTo: "1" },
        decision: null, replied: null, others: [],
      },
    };
    const d = evaluateAutoSend(makeArtifact({ comments: [dup] }), 90);
    expect(d.eligible).toBe(true);
    expect(d.reason).toContain("1 finding(s) already raised by another reviewer left out");

    // A reply is a person's decision to answer somebody; auto-send never posts one.
    const reply = { ...dup, alreadyRaised: { ...dup.alreadyRaised, decision: "reply" as const } };
    const r = evaluateAutoSend(makeArtifact({ comments: [reply] }), 90);
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain("only a human Send posts replies");
  });

  it("waits for a human when the check for duplicates could not run", () => {
    const d = evaluateAutoSend(
      makeArtifact({
        raisedCheck: { at: "t", checkingSince: null, remarks: [], findings: [], error: "gh: rate limited" },
      }),
      90,
    );
    expect(d.eligible).toBe(false);
    expect(d.reason).toContain("gh: rate limited");
  });

  it("waits for a human when the check never ran, or has not finished", () => {
    const never = evaluateAutoSend(makeArtifact({ raisedCheck: null }), 90);
    expect(never.eligible).toBe(false);
    expect(never.reason).toContain("has not finished");
    const running = makeArtifact({
      raisedCheck: { at: "t", checkingSince: "t2", remarks: [], findings: [], error: null },
    });
    expect(evaluateAutoSend(running, 90).eligible).toBe(false);
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
        { id: "1", path: "f", line: 1, body: "x", chapterId: null, severity: null, origin: "ai", status: "draft", editedByUser: false, originalLine: null, drifted: false, alreadyRaised: null },
        { id: "2", path: "f", line: 2, body: "y", chapterId: null, severity: null, origin: "ai", status: "dropped", editedByUser: false, originalLine: null, drifted: false, alreadyRaised: null },
        { id: "3", path: "f", line: 3, body: "z", chapterId: null, severity: null, origin: "ai", status: "approved", editedByUser: true, originalLine: null, drifted: false, alreadyRaised: null },
        { id: "4", path: "f", line: null, body: "mine", chapterId: null, severity: null, origin: "user", status: "draft", editedByUser: false, originalLine: null, drifted: false, alreadyRaised: null },
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
