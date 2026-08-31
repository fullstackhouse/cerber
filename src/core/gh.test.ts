import { execFile } from "node:child_process";
import { Mock, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assembleDiff,
  classifyReply,
  currentLogin,
  lastMentionOfYou,
  fetchPrDiff,
  lastRequestOf,
  latestOwnReview,
  mentionsYou,
  resetLoginCache,
} from "./gh.js";
import { newSideLineText, splitDiffByFile } from "./diff.js";

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

describe("assembleDiff", () => {
  const file = (over: Partial<Parameters<typeof assembleDiff>[0][number]>) => ({
    filename: "src/a.ts",
    status: "modified",
    previous_filename: null,
    additions: 1,
    deletions: 1,
    patch: "@@ -1,2 +1,2 @@\n-old\n+new",
    ...over,
  });

  it("puts the headers back so the result parses like `gh pr diff` output", () => {
    const diff = assembleDiff([file({})]);
    expect(diff).toBe(
      "diff --git a/src/a.ts b/src/a.ts\n" +
        "--- a/src/a.ts\n" +
        "+++ b/src/a.ts\n" +
        "@@ -1,2 +1,2 @@\n-old\n+new\n",
    );
    expect(splitDiffByFile(diff).map((p) => p.path)).toEqual(["src/a.ts"]);
    expect(newSideLineText(diff).get("src/a.ts")?.get(1)).toBe("new");
  });

  it("uses /dev/null on the side an added or removed file does not have", () => {
    const diff = assembleDiff([
      file({ filename: "new.ts", status: "added", patch: "@@ -0,0 +1 @@\n+hello" }),
      file({ filename: "gone.ts", status: "removed", patch: "@@ -1 +0,0 @@\n-bye" }),
    ]);
    expect(diff).toContain("--- /dev/null\n+++ b/new.ts");
    expect(diff).toContain("--- a/gone.ts\n+++ /dev/null");
    // A deletion is attributed to the path it removed, as `gh pr diff` is.
    expect(splitDiffByFile(diff).map((p) => p.path)).toEqual(["new.ts", "gone.ts"]);
  });

  it("names both sides of a rename", () => {
    const diff = assembleDiff([
      file({ filename: "b.ts", status: "renamed", previous_filename: "a.ts" }),
    ]);
    expect(diff).toContain("diff --git a/a.ts b/b.ts");
    expect(diff).toContain("rename from a.ts\nrename to b.ts");
    expect(splitDiffByFile(diff).map((p) => p.path)).toEqual(["b.ts"]);
  });

  it("leaves a pure rename at its rename lines instead of calling it binary", () => {
    // A file that only moved changes no lines and carries no patch — the same
    // shape a binary file arrives in. Counting lines alone would report the
    // move as a binary change, which is wrong and the more alarming way to be
    // wrong. git emits the rename lines and stops; so does this.
    const diff = assembleDiff([
      file({
        filename: "b.ts",
        status: "renamed",
        previous_filename: "a.ts",
        additions: 0,
        deletions: 0,
        patch: null,
      }),
    ]);
    expect(diff).toBe("diff --git a/a.ts b/b.ts\nrename from a.ts\nrename to b.ts\n");
    expect(diff).not.toContain("Binary");
  });

  it("still reports a renamed file's patch when it moved and changed", () => {
    const diff = assembleDiff([
      file({ filename: "b.ts", status: "renamed", previous_filename: "a.ts", patch: "@@ -1 +1 @@\n-old\n+new" }),
    ]);
    expect(diff).toContain("--- a/a.ts\n+++ b/b.ts");
    expect(newSideLineText(diff).get("b.ts")?.get(1)).toBe("new");
  });

  it("says so when GitHub withheld a patch, rather than showing an empty file", () => {
    const diff = assembleDiff([
      file({ filename: "logo.png", status: "added", additions: 0, deletions: 0, patch: null }),
      file({ filename: "huge.md", additions: 523, deletions: 48, patch: null }),
    ]);
    // git names the side an added file does not have /dev/null, here too.
    expect(diff).toContain("Binary files /dev/null and b/logo.png differ");
    expect(diff).toContain("GitHub withheld this file's patch — 523 addition(s), 48 deletion(s)");
    // Neither note may be mistaken for a changed line.
    expect(newSideLineText(diff).get("huge.md")?.size).toBe(0);
  });
});

describe("fetchPrDiff", () => {
  beforeEach(() => vi.clearAllMocks());

  const tooLarge = Object.assign(new Error("failed"), {
    stderr:
      "could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300).\nPullRequest.diff too_large",
  });

  it("re-assembles the diff from the files API when GitHub refuses to render it", async () => {
    exec.mockRejectedValueOnce(tooLarge).mockResolvedValueOnce({
      stdout:
        JSON.stringify({
          filename: "src/a.ts",
          status: "modified",
          previous_filename: null,
          additions: 1,
          deletions: 0,
          patch: "@@ -1 +1,2 @@\n line\n+added",
        }) + "\n",
    });
    const diff = await fetchPrDiff({ owner: "o", repo: "r", number: 1 });
    expect(diff).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(diff).toContain("+added");
    expect(exec.mock.calls[1]![1]).toContain("repos/o/r/pulls/1/files?per_page=100");
  });

  it("flags the files API's own 3000-file cap as doubt, not as a proven loss", async () => {
    const rows = Array.from(
      { length: 3000 },
      (_, i) =>
        JSON.stringify({
          filename: `f${i}.ts`,
          status: "added",
          previous_filename: null,
          additions: 1,
          deletions: 0,
          patch: "@@ -0,0 +1 @@\n+x",
        }) + "\n",
    ).join("");
    exec.mockRejectedValueOnce(tooLarge).mockResolvedValueOnce({ stdout: rows });
    const diff = await fetchPrDiff({ owner: "o", repo: "r", number: 1 });
    // Exactly 3000 files is a PR that may or may not have been truncated, and
    // nothing here can tell the two apart — so the note must not assert one.
    expect(diff).toContain("returns at most 3000 files and returned exactly that many");
    expect(diff).toContain("if this PR changes more");
  });

  it("does not paper over any other gh failure", async () => {
    exec.mockRejectedValue(Object.assign(new Error("failed"), { stderr: "gh: not authenticated" }));
    await expect(fetchPrDiff({ owner: "o", repo: "r", number: 1 })).rejects.toThrow(
      "not authenticated",
    );
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
