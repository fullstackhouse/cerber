import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Mock, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactSchema } from "../core/artifact.js";
import { loadConfig } from "../core/config.js";
import { currentLogin, fetchConversation, mapSearchResults, searchAwaitingMe } from "../core/gh.js";
import { isPureStub, startDaemon, stubArtifact } from "./daemon.js";

// The loop's own bookkeeping is what's under test — not gh, and not the runner.
// classifyReply stays real: it is pure, and its own tests live in core/gh.test.ts.
vi.mock("../core/gh.js", async (orig) => ({
  ...(await orig<typeof import("../core/gh.js")>()),
  searchAwaitingMe: vi.fn(),
  fetchPrInfo: vi.fn(),
  fetchConversation: vi.fn(),
  currentLogin: vi.fn(),
}));
vi.mock("../core/config.js", async (orig) => ({
  ...(await orig<typeof import("../core/config.js")>()),
  loadConfig: vi.fn(),
}));

const search = searchAwaitingMe as Mock;
const config = loadConfig as Mock;
const conversation = fetchConversation as Mock;
const login = currentLogin as Mock;

process.env.CERBER_HOME = mkdtempSync(path.join(os.tmpdir(), "cerber-daemon-"));

const DISCOVERED = {
  owner: "acme",
  repo: "widgets",
  number: 7,
  title: "feat: add sprockets",
  url: "https://github.com/acme/widgets/pull/7",
  updatedAt: "2026-08-19T00:00:00Z",
  isDraft: false,
  author: "someone",
};

describe("the awaiting list the daemon publishes", () => {
  const daemonKnobs = { poll: true, autoReview: true, intervalMinutes: 5, parallel: 1, repos: [] };

  const options = {
    repos: [],
    // Short enough that a second tick lands inside the test, not the interval a
    // real cockpit polls on.
    intervalMs: 10,
    parallel: 1,
    autoReview: false,
    autoSend: "shadow" as const,
    autoSendThreshold: 90,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // A fresh state dir per test: stubs one poll writes must not survive into
    // the next test's queue reconciliation.
    process.env.CERBER_HOME = mkdtempSync(path.join(os.tmpdir(), "cerber-daemon-"));
    config.mockResolvedValue({ trust: [], daemon: daemonKnobs });
    login.mockResolvedValue("me");
    conversation.mockResolvedValue([]);
  });

  /** Run the daemon until it has finished `polls` polls, then stop it. */
  async function pollTimes(polls: number) {
    const handle = startDaemon(options);
    try {
      await vi.waitFor(() => expect(handle.status().polls).toBeGreaterThanOrEqual(polls));
      return handle.status();
    } finally {
      handle.stop();
    }
  }

  it("names the PRs GitHub is waiting on, so the cockpit can say what it hides", async () => {
    search.mockResolvedValue([
      { ...DISCOVERED, owner: "acme", repo: "widgets", number: 7 },
      { ...DISCOVERED, owner: "acme", repo: "gadgets", number: 3 },
    ]);
    const status = await pollTimes(1);
    expect(status.awaiting.map((a) => a.id)).toEqual(["acme/widgets#7", "acme/gadgets#3"]);
    // The same refs the summary counts — one answer, two readouts.
    expect(status.lastSummary).toContain("2 awaiting");
  });

  it("reads each conversation for whose move it is", async () => {
    search.mockResolvedValue([
      { ...DISCOVERED, owner: "acme", repo: "widgets", number: 7 },
      { ...DISCOVERED, owner: "acme", repo: "gadgets", number: 3 },
    ]);
    // #7: you deferred and nobody answered. #3: they came back at you.
    conversation.mockImplementation(async (ref: { number: number }) =>
      ref.number === 7
        ? [{ author: "me", at: "2026-08-19T11:00:00Z", bot: false }]
        : [
            { author: "me", at: "2026-08-19T10:00:00Z", bot: false },
            { author: "them", at: "2026-08-19T12:00:00Z", bot: false },
          ],
    );
    const status = await pollTimes(1);
    expect(status.awaiting).toEqual([
      { id: "acme/widgets#7", reply: "you" },
      { id: "acme/gadgets#3", reply: "them" },
    ]);
  });

  it("says unknown rather than guessing silence it could not confirm", async () => {
    search.mockResolvedValue([DISCOVERED]);
    conversation.mockRejectedValue(new Error("gh: API rate limit exceeded"));
    expect((await pollTimes(1)).awaiting).toEqual([{ id: "acme/widgets#7", reply: "unknown" }]);
  });

  it("attributes nothing when it cannot tell who you are", async () => {
    search.mockResolvedValue([DISCOVERED]);
    login.mockRejectedValue(new Error("gh: not authenticated"));
    expect((await pollTimes(1)).awaiting).toEqual([{ id: "acme/widgets#7", reply: "unknown" }]);
    // The conversation is not worth reading if no comment can be attributed.
    expect(conversation).not.toHaveBeenCalled();
  });

  it("claims nothing while polling is off", async () => {
    search.mockResolvedValue([DISCOVERED]);
    const handle = startDaemon(options);
    try {
      await vi.waitFor(() => expect(handle.status().awaiting).toHaveLength(1));
      config.mockResolvedValue({ trust: [], daemon: { ...daemonKnobs, poll: false } });
      await vi.waitFor(() => expect(handle.status().awaiting).toEqual([]));
    } finally {
      handle.stop();
    }
  });

  it("keeps the last good list when a poll cannot reach GitHub", async () => {
    search.mockResolvedValueOnce([DISCOVERED]).mockRejectedValue(new Error("gh: not authenticated"));
    const status = await pollTimes(2);
    expect(status.awaiting.map((a) => a.id)).toEqual(["acme/widgets#7"]);
    expect(status.lastPollError).toContain("not authenticated");
  });
});

describe("stubArtifact", () => {
  it("produces a schema-valid awaiting artifact from a search hit", () => {
    const stub = stubArtifact(DISCOVERED);
    expect(() => ArtifactSchema.parse(stub)).not.toThrow();
    expect(stub.status).toBe("awaiting");
    expect(stub.id).toBe("acme/widgets#7");
    expect(stub.pr.author).toBe("someone");
    expect(stub.pr.state).toBe("OPEN");
  });

  it("is a pure stub until something touches it", () => {
    const stub = stubArtifact(DISCOVERED);
    expect(isPureStub(stub)).toBe(true);
    // A human comment makes it work worth keeping.
    expect(
      isPureStub({
        ...stub,
        comments: [
          {
            id: "c1",
            path: "a.ts",
            line: 1,
            body: "hm",
            chapterId: null,
            severity: null,
            origin: "user",
            status: "draft",
            editedByUser: false,
            originalLine: null,
            drifted: false,
          },
        ],
      }),
    ).toBe(false);
    // An AI run (even a failed one) is history worth keeping too.
    expect(
      isPureStub({
        ...stub,
        run: {
          model: null,
          startedAt: "2026-08-19T00:00:00Z",
          finishedAt: null,
          costUsd: null,
          error: null,
          withSource: false,
          trusted: false,
          sessionId: null,
        },
      }),
    ).toBe(false);
    expect(isPureStub({ ...stub, status: "ready" })).toBe(false);
  });
});

describe("mapSearchResults author", () => {
  it("carries the author login through", () => {
    const [pr] = mapSearchResults([
      {
        number: 7,
        title: "t",
        url: "u",
        updatedAt: "2026-08-19T00:00:00Z",
        isDraft: false,
        repository: { nameWithOwner: "acme/widgets" },
        author: { login: "someone" },
      },
    ]);
    expect(pr?.author).toBe("someone");
  });

  it("tolerates a missing author (bots, deleted users)", () => {
    const [pr] = mapSearchResults([
      {
        number: 7,
        title: "t",
        url: "u",
        updatedAt: "2026-08-19T00:00:00Z",
        isDraft: false,
        repository: { nameWithOwner: "acme/widgets" },
      },
    ]);
    expect(pr?.author).toBe("");
  });
});
