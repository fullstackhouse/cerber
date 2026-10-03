import { describe, expect, it } from "vitest";
import {
  AiReviewSchema,
  ArtifactSchema,
  CommentSchema,
  HandoffInfoSchema,
  SCHEMA_VERSION,
} from "./artifact.js";

// Severity is additive on schema version 1: artifacts written before it
// existed (and hand-edited ones that omit it) must keep parsing, and absent
// must mean "not a finding", never an error.
describe("CommentSchema severity", () => {
  const base = {
    id: "c1",
    path: "src/a.ts",
    line: 2,
    body: "note",
    origin: "ai",
  };

  it("defaults to null when absent, so pre-severity artifacts still parse", () => {
    expect(SCHEMA_VERSION).toBe(1);
    const c = CommentSchema.parse(base);
    expect(c.severity).toBeNull();
  });

  it("round-trips each tier", () => {
    for (const severity of ["blocker", "minor", "nit"] as const) {
      expect(CommentSchema.parse({ ...base, severity }).severity).toBe(severity);
    }
  });

  it("rejects grades outside the vocabulary", () => {
    expect(() => CommentSchema.parse({ ...base, severity: "major" })).toThrow();
    expect(() => CommentSchema.parse({ ...base, severity: "critical" })).toThrow();
  });
});

describe("AiReviewSchema severity", () => {
  const review = (comment: object) => ({
    summary: "s",
    chapters: [],
    comments: [comment],
    verdict: { recommendation: "approve", confidence: 80, reasoning: "r" },
  });

  it("accepts a graded finding", () => {
    const ai = AiReviewSchema.parse(
      review({ path: "a.ts", line: 1, body: "b", severity: "blocker" }),
    );
    expect(ai.comments[0]!.severity).toBe("blocker");
  });

  it("accepts an ungraded remark — a question is not a finding", () => {
    const ai = AiReviewSchema.parse(review({ path: "a.ts", line: 1, body: "why?" }));
    expect(ai.comments[0]!.severity).toBeUndefined();
  });
});

// `handoff` is additive on schema version 1 too, and every fixture in the suite
// now writes it explicitly because the parsed type requires it — which means
// nothing else here exercises the case that actually matters: the thousands of
// artifacts already on disk that have never heard of the field.
describe("ArtifactSchema handoff", () => {
  const minimal = {
    schemaVersion: SCHEMA_VERSION,
    id: "o/r#1",
    status: "ready",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    pr: {
      owner: "o",
      repo: "r",
      number: 1,
      title: "t",
      url: "https://github.com/o/r/pull/1",
      author: "a",
      baseRefName: "main",
      headRefName: "f",
      headSha: "abc",
    },
    diff: "",
  };

  it("reads an artifact written before the field existed", () => {
    // If this ever throws, every review on disk stops loading at once — the
    // queue, not one row.
    expect(ArtifactSchema.parse(minimal).handoff).toBeNull();
  });

  it("fills in the halves a hand-edited record leaves out", () => {
    // The file is user-editable, so the two fields that carry *meaning* about
    // GitHub's state need defaults that read as the common case: you were taken
    // off, and nothing was posted.
    expect(HandoffInfoSchema.parse({ at: "2026-01-01T00:00:00Z", to: "maks" })).toEqual({
      at: "2026-01-01T00:00:00Z",
      to: "maks",
      withdrewYours: true,
      note: null,
    });
  });
});
