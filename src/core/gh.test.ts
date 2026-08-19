import { describe, expect, it } from "vitest";
import { ghErrorDetail, parsePrRef } from "./gh.js";

describe("parsePrRef", () => {
  it("parses a full PR URL", () => {
    expect(parsePrRef("https://github.com/fullstackhouse/skills/pull/22")).toEqual({
      owner: "fullstackhouse",
      repo: "skills",
      number: 22,
    });
  });

  it("parses owner/repo#number", () => {
    expect(parsePrRef("open-mercato/cezar#7")).toEqual({
      owner: "open-mercato",
      repo: "cezar",
      number: 7,
    });
  });

  it("parses a bare number with --repo", () => {
    expect(parsePrRef("123", "a/b")).toEqual({ owner: "a", repo: "b", number: 123 });
    expect(parsePrRef("#123", "a/b")).toEqual({ owner: "a", repo: "b", number: 123 });
  });

  it("rejects a bare number without --repo", () => {
    expect(() => parsePrRef("123")).toThrow(/--repo/);
  });

  it("rejects garbage", () => {
    expect(() => parsePrRef("what is this")).toThrow(/Cannot parse/);
  });
});

describe("ghErrorDetail", () => {
  it("adds the errors[] detail gh swallows", () => {
    const body = JSON.stringify({
      message: "Unprocessable Entity",
      errors: ["pull_request_review_thread.line must be part of the diff"],
    });
    expect(ghErrorDetail("gh: Unprocessable Entity (HTTP 422)", body)).toBe(
      "gh: Unprocessable Entity (HTTP 422) — pull_request_review_thread.line must be part of the diff",
    );
  });

  it("describes object-shaped errors", () => {
    const body = JSON.stringify({
      message: "Validation Failed",
      errors: [{ resource: "Search", field: "q", code: "missing" }],
    });
    expect(ghErrorDetail("gh: Validation Failed (HTTP 422)", body)).toBe(
      "gh: Validation Failed (HTTP 422) — Search.q: missing",
    );
  });

  it("falls back to stderr when the body is not JSON", () => {
    expect(ghErrorDetail("gh: Not Found (HTTP 404)", "<html>")).toBe("gh: Not Found (HTTP 404)");
    expect(ghErrorDetail(undefined, undefined)).toBe("");
  });
});
