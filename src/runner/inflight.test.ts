import { describe, expect, it } from "vitest";
import { ReviewInProgressError, beginReview, endReview, isReviewRunning } from "./inflight.js";

describe("in-flight review registry", () => {
  it("lets one claim through and rejects the second", () => {
    beginReview("o/r#1");
    expect(isReviewRunning("o/r#1")).toBe(true);
    expect(() => beginReview("o/r#1")).toThrow(ReviewInProgressError);
    endReview("o/r#1");
    expect(isReviewRunning("o/r#1")).toBe(false);
  });

  it("tracks PRs independently", () => {
    beginReview("o/r#1");
    expect(() => beginReview("o/r#2")).not.toThrow();
    endReview("o/r#1");
    endReview("o/r#2");
  });

  it("frees the slot again after release", () => {
    beginReview("o/r#3");
    endReview("o/r#3");
    expect(() => beginReview("o/r#3")).not.toThrow();
    endReview("o/r#3");
  });
});
