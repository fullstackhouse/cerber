import { execFile } from "node:child_process";
import { Mock, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyReply,
  currentLogin,
  lastMentionOfYou,
  lastRequestOf,
  latestOwnReview,
  mentionsYou,
  resetLoginCache,
} from "./gh.js";

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
  const c = (author: string, at: string, body = "") => ({
    author,
    at,
    body,
    bot: false,
    url: `#${author}-${at}`,
  });
  const bot = (author: string, at: string, body = "") => ({ author, at, body, bot: true, url: null });

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

describe("mentionsYou", () => {
  it("finds your name however the sentence puts it", () => {
    expect(mentionsYou("@me this is ready for another look", "me")).toBe(true);
    expect(mentionsYou("ready now, @me", "me")).toBe(true);
    expect(mentionsYou("cc (@me) when you get a sec", "me")).toBe(true);
    expect(mentionsYou("done — @me?", "me")).toBe(true);
  });

  it("is not fooled by a longer name that starts with yours", () => {
    // The bot that shares your prefix asks for you on every push otherwise.
    expect(mentionsYou("@me-bot rebuilt the preview", "me")).toBe(false);
    expect(mentionsYou("@median said the same thing", "me")).toBe(false);
  });

  it("does not read an email address as an ask", () => {
    expect(mentionsYou("mail jacek@me.dev if it breaks", "me")).toBe(false);
  });

  it("ignores the case GitHub itself ignores", () => {
    expect(mentionsYou("@ME ready", "me")).toBe(true);
  });

  it("says nothing about a comment that names nobody", () => {
    expect(mentionsYou("rebased onto main", "me")).toBe(false);
    expect(mentionsYou("", "me")).toBe(false);
  });

  it("does not take a team's name for yours", () => {
    // A room being addressed is not somebody asking for you, and this undoes
    // a decision of yours — see `trust.ts` for where teams do count.
    expect(mentionsYou("@acme/reviewers could someone look", "me")).toBe(false);
  });
});

describe("lastMentionOfYou", () => {
  const said = (author: string, at: string, body: string, bot = false) => ({
    author,
    at,
    body,
    bot,
    url: `#${author}-${at}`,
  });

  it("returns the newest comment that named you", () => {
    const found = lastMentionOfYou(
      [
        said("them", "2026-08-19T10:00:00Z", "@me first look?"),
        said("them", "2026-08-21T10:00:00Z", "@me ready again"),
        said("them", "2026-08-22T10:00:00Z", "rebased"),
      ],
      "me",
    );
    expect(found?.at).toBe("2026-08-21T10:00:00Z");
  });

  it("reads dates rather than trusting the order they arrived in", () => {
    const found = lastMentionOfYou(
      [said("them", "2026-08-21T10:00:00Z", "@me later"), said("them", "2026-08-19T10:00:00Z", "@me earlier")],
      "me",
    );
    expect(found?.at).toBe("2026-08-21T10:00:00Z");
  });

  it("never counts you asking for yourself", () => {
    expect(lastMentionOfYou([said("me", "2026-08-19T10:00:00Z", "cc @me")], "me")).toBeNull();
  });

  it("never counts a bot that @-mentions the reviewer", () => {
    expect(
      lastMentionOfYou([said("ci[bot]", "2026-08-19T10:00:00Z", "@me the build is green")], "me"),
    ).toBeNull();
  });

  it("says nobody asked when nobody used your name", () => {
    expect(lastMentionOfYou([said("them", "2026-08-19T10:00:00Z", "ready for review")], "me")).toBeNull();
    expect(lastMentionOfYou([], "me")).toBeNull();
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

describe("lastRequestOf", () => {
  const asked = (login: string, createdAt: string, typename = "User") => ({
    createdAt,
    requestedReviewer: { __typename: typename, login },
  });

  it("finds nothing when nobody has asked you", () => {
    expect(lastRequestOf([], "me")).toBeNull();
    expect(lastRequestOf([asked("them", "2026-08-20T10:00:00Z")], "me")).toBeNull();
  });

  // The whole point: a request that was withdrawn and made again is a second
  // ask, and only its timestamp can tell it from the first.
  it("takes the most recent ask, not the first", () => {
    expect(
      lastRequestOf(
        [
          asked("me", "2026-08-21T10:43:27Z"),
          asked("them", "2026-08-24T11:00:00Z"),
          asked("me", "2026-08-24T12:41:22Z"),
        ],
        "me",
      ),
    ).toBe("2026-08-24T12:41:22Z");
  });

  // A team request names the team, never you. This answer decides whether to
  // undo a decision of yours, so it acts only on somebody naming you.
  it("ignores requests that did not name you", () => {
    expect(lastRequestOf([{ createdAt: "2026-08-24T12:41:22Z", requestedReviewer: { __typename: "Team" } }], "me")).toBeNull();
    expect(lastRequestOf([asked("me", "2026-08-24T12:41:22Z", "Bot")], "me")).toBeNull();
    expect(lastRequestOf([{ createdAt: "2026-08-24T12:41:22Z", requestedReviewer: null }], "me")).toBeNull();
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
