import { execFile } from "node:child_process";
import { Mock, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyReply, currentLogin, latestOwnReview, resetLoginCache } from "./gh.js";

// gh.ts calls `promisify(execFile)`, which honours this symbol — so the mock
// resolves to the `{ stdout }` shape the real one does, while still recording
// the calls on the spy itself.
vi.mock("node:child_process", () => {
  const execFile = vi.fn();
  (execFile as unknown as Record<symbol, unknown>)[Symbol.for("nodejs.util.promisify.custom")] = (
    ...args: unknown[]
  ) => Promise.resolve(execFile(...(args as [])));
  return { execFile };
});
const exec = execFile as unknown as Mock;

describe("currentLogin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLoginCache();
  });

  it("asks gh once and reuses the answer", async () => {
    exec.mockResolvedValue({ stdout: "jtomaszewski\n" });
    expect(await currentLogin()).toBe("jtomaszewski");
    expect(await currentLogin()).toBe("jtomaszewski");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("retries after a failure instead of failing forever", async () => {
    // A cached rejection would leave every later poll reporting "unknown"
    // until the process restarts — gh being briefly offline or mid-re-auth
    // must not permanently disable whose-move detection.
    exec
      .mockRejectedValueOnce(Object.assign(new Error("boom"), { stderr: "gh: not authenticated" }))
      .mockResolvedValue({ stdout: "jtomaszewski\n" });
    await expect(currentLogin()).rejects.toThrow("not authenticated");
    expect(await currentLogin()).toBe("jtomaszewski");
    expect(exec).toHaveBeenCalledTimes(2);
  });
});

describe("classifyReply", () => {
  const c = (author: string, at: string) => ({ author, at, bot: false });
  const bot = (author: string, at: string) => ({ author, at, bot: true });

  it("says nobody has heard from you when you never spoke", () => {
    expect(classifyReply([], "me")).toBe("none");
    expect(classifyReply([c("them", "2026-08-19T10:00:00Z")], "me")).toBe("none");
  });

  it("leaves the move with them while yours is the last word", () => {
    expect(
      classifyReply([c("them", "2026-08-19T10:00:00Z"), c("me", "2026-08-19T11:00:00Z")], "me"),
    ).toBe("you");
  });

  it("hands the move back when someone answers after you", () => {
    expect(
      classifyReply(
        [c("me", "2026-08-19T10:00:00Z"), c("them", "2026-08-19T11:00:00Z")],
        "me",
      ),
    ).toBe("them");
  });

  it("weighs your LAST word, not your first", () => {
    // Argue, get answered, argue again: the move is theirs, not yours.
    expect(
      classifyReply(
        [
          c("me", "2026-08-19T10:00:00Z"),
          c("them", "2026-08-19T11:00:00Z"),
          c("me", "2026-08-19T12:00:00Z"),
        ],
        "me",
      ),
    ).toBe("you");
  });

  it("does not treat a simultaneous comment as an answer to yours", () => {
    const t = "2026-08-19T10:00:00Z";
    expect(classifyReply([c("me", t), c("them", t)], "me")).toBe("you");
  });

  it("does not let a bot hand the move back to you", () => {
    // A repo whose CI comments on every push would otherwise read
    // "they replied last" on every PR, and the tag would mean nothing.
    expect(
      classifyReply(
        [c("me", "2026-08-19T10:00:00Z"), bot("github-actions[bot]", "2026-08-19T11:00:00Z")],
        "me",
      ),
    ).toBe("you");
  });

  it("spots a bot by its name when GitHub does not type it as one", () => {
    expect(
      classifyReply(
        [c("me", "2026-08-19T10:00:00Z"), c("notion-workspace[bot]", "2026-08-19T11:00:00Z")],
        "me",
      ),
    ).toBe("you");
  });

  it("never counts a bot as you having spoken", () => {
    expect(classifyReply([bot("me", "2026-08-19T10:00:00Z")], "me")).toBe("none");
  });
});
import { ghErrorDetail, parsePrRef, searchAwaitingArgs } from "./gh.js";

describe("latestOwnReview", () => {
  const r = (author: string, at: string | null, state: string) => ({
    author,
    at,
    state,
    url: "https://github.com/acme/widgets/pull/7#pullrequestreview-1",
  });

  it("finds nothing when only other people have reviewed", () => {
    expect(latestOwnReview([r("them", "2026-08-19T10:00:00Z", "APPROVED")], "me")).toBeNull();
    expect(latestOwnReview([], "me")).toBeNull();
  });

  it("takes your latest review, whatever kind it was", () => {
    const found = latestOwnReview(
      [
        r("me", "2026-08-19T10:00:00Z", "COMMENTED"),
        r("them", "2026-08-20T09:00:00Z", "APPROVED"),
        r("me", "2026-08-20T14:55:00Z", "CHANGES_REQUESTED"),
      ],
      "me",
    );
    expect(found?.at).toBe("2026-08-20T14:55:00Z");
    expect(found?.state).toBe("CHANGES_REQUESTED");
  });

  // A review you started and never submitted is one nobody has seen — GitHub
  // leaves it PENDING with no submitted_at, and still asks you for a review.
  it("ignores a pending review of your own", () => {
    expect(latestOwnReview([r("me", null, "PENDING")], "me")).toBeNull();
  });

  // Dismissing is a maintainer striking the review off. Counting it would file
  // work away on the strength of a review GitHub itself no longer honours.
  it("ignores a review that was dismissed", () => {
    expect(latestOwnReview([r("me", "2026-08-19T10:00:00Z", "DISMISSED")], "me")).toBeNull();
  });
});

describe("parsePrRef", () => {
  it("parses a full PR URL", () => {
    expect(parsePrRef("https://github.com/fullstackhouse/skills/pull/22")).toEqual({
      owner: "fullstackhouse",
      repo: "skills",
      number: 22,
    });
  });

  it("parses owner/repo#number", () => {
    expect(parsePrRef("open-mercato/backoffice#7")).toEqual({
      owner: "open-mercato",
      repo: "backoffice",
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

describe("searchAwaitingArgs", () => {
  it("skips archived repos — read-only, so their PRs never leave the inbox", () => {
    expect(searchAwaitingArgs()).toContain("archived:false");
  });

  it("keeps the repo filter and limit", () => {
    const args = searchAwaitingArgs("acme/widgets", 10);
    expect(args).toContain("archived:false");
    expect(args.slice(args.indexOf("--repo"), args.indexOf("--repo") + 2)).toEqual([
      "--repo",
      "acme/widgets",
    ]);
    expect(args.slice(args.indexOf("--limit"), args.indexOf("--limit") + 2)).toEqual([
      "--limit",
      "10",
    ]);
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
