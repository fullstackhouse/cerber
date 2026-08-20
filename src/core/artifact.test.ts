import { describe, expect, it } from "vitest";
import { AiReviewSchema, CommentSchema, SCHEMA_VERSION } from "./artifact.js";

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
