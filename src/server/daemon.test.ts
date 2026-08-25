import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Mock, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactSchema } from "../core/artifact.js";
import { loadConfig } from "../core/config.js";
import {
  currentLogin,
  fetchConversation,
  fetchLastReviewRequest,
  fetchOwnReview,
  fetchPrInfo,
  fetchReviewRequests,
  mapSearchResults,
  searchAwaitingMe,
} from "../core/gh.js";
import { notify } from "../core/notify.js";
import { loadArtifact, saveArtifact } from "../core/state.js";
import {
  DaemonHandle,
  askedAgainAfterSettling,
  filedByWithdrawnRequest,
  filedByYourAct,
  isPureStub,
  reopenedStatus,
  settledAtOf,
  startDaemon,
  stubArtifact,
} from "./daemon.js";

// The loop's own bookkeeping is what's under test — not gh, and not the runner.
// classifyReply and lastWordOfYours stay real: they are pure, and their own
// tests live in core/gh.test.ts.
vi.mock("../core/gh.js", async (orig) => ({
  ...(await orig<typeof import("../core/gh.js")>()),
  searchAwaitingMe: vi.fn(),
  fetchPrInfo: vi.fn(),
  fetchConversation: vi.fn(),
  fetchLastReviewRequest: vi.fn(),
  fetchOwnReview: vi.fn(),
  fetchReviewRequests: vi.fn(),
  currentLogin: vi.fn(),
}));
vi.mock("../core/config.js", async (orig) => ({
  ...(await orig<typeof import("../core/config.js")>()),
  loadConfig: vi.fn(),
}));
// The notice itself is pure and tested in core/notify.test.ts; what matters
// here is which arrivals reach it, and when nothing should.
vi.mock("../core/notify.js", async (orig) => ({
  ...(await orig<typeof import("../core/notify.js")>()),
  notify: vi.fn(),
}));

const search = searchAwaitingMe as Mock;
const prInfo = fetchPrInfo as Mock;
const config = loadConfig as Mock;
const conversation = fetchConversation as Mock;
const ownReview = fetchOwnReview as Mock;
const lastRequest = fetchLastReviewRequest as Mock;
const requests = fetchReviewRequests as Mock;
const login = currentLogin as Mock;
const notified = notify as Mock;

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

/**
 * Stop a daemon and wait until it has actually gone quiet.
 *
 * `stop()` clears the timer, but a poll already in flight runs to the end — and
 * CERBER_HOME is rebound in every `beforeEach`, so that straggler would do its
 * discovering inside the *next* test's home and announce there, against the
 * next test's spies. Draining here is what gives each test its own world.
 */
async function stopAndDrain(handle: DaemonHandle): Promise<void> {
  handle.stop();
  await vi.waitFor(() => expect(handle.status().polling).toBe(false));
}

describe("the awaiting list the daemon publishes", () => {
  const daemonKnobs = {
    poll: true,
    autoReview: true,
    notify: true,
    intervalMinutes: 5,
    parallel: 1,
    repos: [],
  };

  const options = {
    repos: [],
    // Short enough that a second tick lands inside the test, not the interval a
    // real cockpit polls on.
    intervalMs: 10,
    parallel: 1,
    autoReview: false,
    notify: true,
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
    ownReview.mockResolvedValue(null);
  });

  /** Run the daemon until it has finished `polls` polls, then stop it. */
  async function pollTimes(polls: number) {
    const handle = startDaemon(options);
    try {
      await vi.waitFor(() => expect(handle.status().polls).toBeGreaterThanOrEqual(polls));
      return handle.status();
    } finally {
      await stopAndDrain(handle);
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
      await stopAndDrain(handle);
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
          trigger: null,
          reviewedSha: null,
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

/**
 * A draft carrying a review request is a review someone is waiting on, so it
 * belongs in the queue — and the badge that says so has to keep up when the
 * author marks the PR ready. Neither refresh below costs an extra GitHub call:
 * one reuses the search result already in hand, the other rides a fetchPrInfo
 * the daemon was making anyway.
 */
describe("draft PRs in the inbox", () => {
  const daemonKnobs = {
    poll: true,
    autoReview: true,
    notify: true,
    intervalMinutes: 5,
    parallel: 1,
    repos: [],
  };
  const options = {
    repos: [],
    intervalMs: 10,
    parallel: 1,
    autoReview: false,
    notify: true,
    autoSend: "shadow" as const,
    autoSendThreshold: 90,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CERBER_HOME = mkdtempSync(path.join(os.tmpdir(), "cerber-daemon-draft-"));
    config.mockResolvedValue({ trust: [], daemon: daemonKnobs });
    login.mockResolvedValue("me");
    conversation.mockResolvedValue([]);
    ownReview.mockResolvedValue(null);
  });

  async function pollOnce() {
    const handle = startDaemon(options);
    try {
      await vi.waitFor(() => expect(handle.status().polls).toBeGreaterThanOrEqual(1));
      return handle.status();
    } finally {
      await stopAndDrain(handle);
    }
  }

  it("lists a draft awaiting your review instead of hiding it", async () => {
    search.mockResolvedValue([{ ...DISCOVERED, isDraft: true }]);
    const status = await pollOnce();
    expect(status.awaiting.map((a) => a.id)).toEqual(["acme/widgets#7"]);
    expect((await loadArtifact("acme/widgets#7"))?.pr.isDraft).toBe(true);
  });

  it("stops calling a PR a draft once its author marks it ready", async () => {
    await saveArtifact({
      ...stubArtifact({ ...DISCOVERED, isDraft: true }),
      status: "ready",
      comments: [],
    });
    expect((await loadArtifact("acme/widgets#7"))?.pr.isDraft).toBe(true);

    // Same PR, next poll, no longer a draft. The search already says so, so
    // nothing needs to be fetched to find out.
    search.mockResolvedValue([{ ...DISCOVERED, isDraft: false }]);
    await pollOnce();

    expect((await loadArtifact("acme/widgets#7"))?.pr.isDraft).toBe(false);
    expect(prInfo).not.toHaveBeenCalled();
  });

  it("corrects the flag on a pulled-in PR the awaiting search never returns", async () => {
    // Pasted into the cockpit rather than discovered: it has a run, so the
    // reaper leaves it alone, but it will never appear in the search either.
    await saveArtifact({
      ...stubArtifact({ ...DISCOVERED, isDraft: true }),
      status: "ready",
      run: {
        model: "claude",
        startedAt: "2026-08-19T00:00:00Z",
        finishedAt: "2026-08-19T00:01:00Z",
        costUsd: 0.1,
        error: null,
        withSource: true,
        trusted: false,
        sessionId: null,
        trigger: null,
        reviewedSha: null,
      },
    });

    search.mockResolvedValue([]);
    prInfo.mockResolvedValue({
      ...stubArtifact({ ...DISCOVERED, isDraft: false }).pr,
      state: "OPEN",
      isDraft: false,
    });
    await pollOnce();

    const after = await loadArtifact("acme/widgets#7");
    expect(after).not.toBeNull();
    expect(after?.pr.isDraft).toBe(false);
    // Still here — the periodic refresh corrects the flag, it does not archive
    // a PR that is merely absent from the search.
    expect(after?.pr.state).toBe("OPEN");
  });
});

/**
 * A review you submit through GitHub itself never reaches the queue, so the
 * draft cerber wrote for the same PR went on sitting in the inbox as work
 * still waiting on you — days after you had answered the author. The poll
 * closes that gap the only way it can: by asking GitHub whether you already
 * reviewed the PR it has stopped requesting from you.
 */
describe("a draft you already answered on GitHub", () => {
  const daemonKnobs = {
    poll: true,
    autoReview: true,
    notify: true,
    intervalMinutes: 5,
    parallel: 1,
    repos: [],
  };
  const options = {
    repos: [],
    intervalMs: 10,
    parallel: 1,
    autoReview: false,
    notify: true,
    autoSend: "shadow" as const,
    autoSendThreshold: 90,
  };

  const RUN = {
    model: "claude",
    startedAt: "2026-08-20T15:03:00Z",
    finishedAt: "2026-08-20T15:08:00Z",
    costUsd: 4.9,
    error: null,
    withSource: true,
    trusted: true,
    sessionId: null,
    trigger: "daemon" as const,
    reviewedSha: null,
  };

  const YOUR_REVIEW = {
    at: "2026-08-20T14:55:00Z",
    state: "CHANGES_REQUESTED" as const,
    url: "https://github.com/acme/widgets/pull/7#pullrequestreview-1",
  };

  /** A finished draft nobody has settled — the row that used to get stuck. */
  const draft = (over: Record<string, unknown> = {}) => ({
    ...stubArtifact(DISCOVERED),
    status: "ready" as const,
    run: RUN,
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CERBER_HOME = mkdtempSync(path.join(os.tmpdir(), "cerber-daemon-filed-"));
    config.mockResolvedValue({ trust: [], daemon: daemonKnobs });
    login.mockResolvedValue("me");
    conversation.mockResolvedValue([]);
    ownReview.mockResolvedValue(null);
    requests.mockResolvedValue({ users: [], teams: [] });
    prInfo.mockResolvedValue({ ...stubArtifact(DISCOVERED).pr, state: "OPEN", isDraft: false });
  });

  const said = (author: string, at: string) => ({
    author,
    at,
    bot: false,
    url: `https://github.com/acme/widgets/pull/7#issuecomment-${at}`,
  });

  async function pollOnce() {
    const handle = startDaemon(options);
    try {
      await vi.waitFor(() => expect(handle.status().polls).toBeGreaterThanOrEqual(1));
    } finally {
      await stopAndDrain(handle);
    }
    return loadArtifact("acme/widgets#7");
  }

  it("files the draft once GitHub stops asking and shows a review of yours", async () => {
    await saveArtifact(draft());
    search.mockResolvedValue([]);
    ownReview.mockResolvedValue(YOUR_REVIEW);

    const after = await pollOnce();
    expect(after?.status).toBe("reviewed");
    expect(after?.filed?.reason).toBe("own-review");
    expect(after?.filed?.review?.at).toBe(YOUR_REVIEW.at);
    // Filed, not sent, not thrown away: the draft is still there to send.
    expect(after?.sent).toBeNull();
    expect(after?.pr.state).toBe("OPEN");
  });

  it("leaves it in the inbox while GitHub is still asking you", async () => {
    await saveArtifact(draft());
    // Re-requested after your review: the request is the whole point, so the
    // artifact never reaches the check at all.
    search.mockResolvedValue([DISCOVERED]);
    ownReview.mockResolvedValue(YOUR_REVIEW);

    const after = await pollOnce();
    expect(after?.status).toBe("ready");
    expect(after?.filed).toBeNull();
    expect(ownReview).not.toHaveBeenCalled();
  });

  it("files a draft nobody is asking for any more", async () => {
    // Never reviewed, never commented, and the request has gone: the row is a
    // draft the poll wrote for a question that no longer exists.
    await saveArtifact(draft());
    search.mockResolvedValue([]);

    const after = await pollOnce();
    expect(after?.status).toBe("reviewed");
    expect(after?.filed?.reason).toBe("request-withdrawn");
    expect(after?.sent).toBeNull();
  });

  it("confirms against the PR before believing the request is gone", async () => {
    // The awaiting search runs off an index that lags, and here its silence is
    // the entire case for filing — so the PR itself gets the last word.
    await saveArtifact(draft());
    search.mockResolvedValue([]);
    requests.mockResolvedValue({ users: ["me"], teams: [] });

    const after = await pollOnce();
    expect(after?.status).toBe("ready");
    expect(after?.filed).toBeNull();
  });

  it("will not rule you out of a team's review request", async () => {
    // A team request names the team, never its members. It cannot say the
    // request is not yours, so it is not allowed to say it is gone.
    await saveArtifact(draft());
    search.mockResolvedValue([]);
    requests.mockResolvedValue({ users: [], teams: ["acme/backend"] });

    const after = await pollOnce();
    expect(after?.status).toBe("ready");
    expect(after?.filed).toBeNull();
  });

  it("never files a draft you pulled in yourself as unrequested", async () => {
    // A pasted PR was never in the awaiting search, so its absence there says
    // nothing at all — and a run too old to record a trigger can't be told from
    // one, so it gets the same answer.
    for (const trigger of ["user", null] as const) {
      await saveArtifact(draft({ run: { ...RUN, trigger } }));
      search.mockResolvedValue([]);

      const after = await pollOnce();
      expect(after?.status).toBe("ready");
      expect(after?.filed).toBeNull();
    }
  });

  it("files the draft when you answered on the PR and nobody answered back", async () => {
    // A comment is not a review as far as GitHub is concerned, so the request
    // it leaves standing says nothing about whether anyone is waiting on you.
    await saveArtifact(draft());
    search.mockResolvedValue([]);
    conversation.mockResolvedValue([
      said("someone", "2026-08-20T09:00:00Z"),
      said("me", "2026-08-20T14:00:00Z"),
    ]);

    const after = await pollOnce();
    expect(after?.status).toBe("reviewed");
    expect(after?.filed?.reason).toBe("own-reply");
    expect(after?.filed?.reply?.at).toBe("2026-08-20T14:00:00Z");
    expect(after?.filed?.reply?.url).toContain("issuecomment");
  });

  it("leaves the row alone when someone answered your comment", async () => {
    // That reply is addressed to you, on a PR whose draft is sitting right here.
    await saveArtifact(draft());
    search.mockResolvedValue([]);
    conversation.mockResolvedValue([
      said("me", "2026-08-20T09:00:00Z"),
      said("someone", "2026-08-20T14:00:00Z"),
    ]);

    const after = await pollOnce();
    expect(after?.status).toBe("ready");
    expect(after?.filed).toBeNull();
  });

  it("keeps a second opinion you asked for after commenting", async () => {
    await saveArtifact(
      draft({ run: { ...RUN, trigger: "user" as const, startedAt: "2026-08-21T09:00:00Z" } }),
    );
    search.mockResolvedValue([]);
    conversation.mockResolvedValue([said("me", "2026-08-20T14:00:00Z")]);

    const after = await pollOnce();
    expect(after?.status).toBe("ready");
    expect(after?.filed).toBeNull();
  });

  it("does not go looking for another reason once it has found your review", async () => {
    // You reviewed on GitHub, then asked for a fresh draft. The guard spares it
    // — and nothing downstream may file it on the strength of the same comment.
    await saveArtifact(
      draft({ run: { ...RUN, trigger: "user" as const, startedAt: "2026-08-21T09:00:00Z" } }),
    );
    search.mockResolvedValue([]);
    ownReview.mockResolvedValue(YOUR_REVIEW);
    conversation.mockResolvedValue([said("me", "2026-08-20T14:00:00Z")]);

    const after = await pollOnce();
    expect(after?.status).toBe("ready");
    expect(after?.filed).toBeNull();
    expect(conversation).not.toHaveBeenCalled();
  });

  it("keeps a second opinion you asked for after reviewing", async () => {
    // You reviewed on GitHub, then pulled the PR back in for a fresh draft.
    // Filing that away would answer a question you had just posed.
    await saveArtifact(
      draft({ run: { ...RUN, trigger: "user" as const, startedAt: "2026-08-21T09:00:00Z" } }),
    );
    search.mockResolvedValue([]);
    ownReview.mockResolvedValue(YOUR_REVIEW);

    const after = await pollOnce();
    expect(after?.status).toBe("ready");
    expect(after?.filed).toBeNull();
  });

  it("never files a review that was already sent", async () => {
    await saveArtifact(
      draft({
        status: "sent" as const,
        sent: { at: "2026-08-20T16:00:00Z", event: "COMMENT" as const, url: null, auto: false },
      }),
    );
    search.mockResolvedValue([]);
    ownReview.mockResolvedValue(YOUR_REVIEW);

    const after = await pollOnce();
    expect(after?.status).toBe("sent");
    expect(after?.filed).toBeNull();
  });
});

describe("filedByYourAct", () => {
  const artifact = { ...stubArtifact(DISCOVERED), status: "ready" as const };
  const review = { at: "2026-08-20T14:55:00Z", state: "COMMENTED" as const, url: null };

  it("needs something you did to file anything", () => {
    expect(filedByYourAct(artifact, null)).toBe(false);
    expect(filedByYourAct(artifact, review.at)).toBe(true);
  });

  // ISO-8601 does not compare as text across precisions: `startedAt` carries
  // milliseconds, GitHub's `submitted_at` does not, and "…:00.500Z" sorts
  // before "…:00Z". Compared as strings, a run that began half a second after
  // the review reads as older, and the draft it protects gets filed away.
  it("keeps a second opinion that started milliseconds after your review", () => {
    // Same second on both sides — the only place the precision mismatch shows.
    const sameSecond = { ...review, at: "2026-08-20T14:55:26Z" };
    const run = {
      model: null,
      startedAt: "2026-08-20T14:55:26.500Z",
      finishedAt: null,
      costUsd: null,
      error: null,
      withSource: false,
      trusted: false,
      sessionId: null,
      trigger: "user" as const,
      reviewedSha: null,
    };
    expect(filedByYourAct({ ...artifact, run }, sameSecond.at)).toBe(false);
    // And the same run started a second *before* it still files: the guard is
    // about order, not about having a trigger at all.
    expect(
      filedByYourAct(
        { ...artifact, run: { ...run, startedAt: "2026-08-20T14:55:25.500Z" } },
        sameSecond.at,
      ),
    ).toBe(true);
  });

  it("only files a finished draft", () => {
    expect(filedByYourAct({ ...artifact, status: "running" }, review.at)).toBe(false);
    expect(filedByYourAct({ ...artifact, status: "awaiting" }, review.at)).toBe(false);
    expect(filedByYourAct({ ...artifact, status: "skipped" }, review.at)).toBe(false);
  });
});

describe("filedByWithdrawnRequest", () => {
  const artifact = { ...stubArtifact(DISCOVERED), status: "ready" as const };
  const run = {
    model: null,
    startedAt: "2026-08-20T14:55:00Z",
    finishedAt: null,
    costUsd: null,
    error: null,
    withSource: false,
    trusted: false,
    sessionId: null,
    trigger: "daemon" as const,
    reviewedSha: null,
  };

  it("only files what the poll wrote on its own", () => {
    expect(filedByWithdrawnRequest({ ...artifact, run })).toBe(true);
    expect(filedByWithdrawnRequest({ ...artifact, run: { ...run, trigger: "user" } })).toBe(false);
    // No corroborating act of yours here, so an unrecorded trigger means no —
    // the opposite of the own-review guard, which has a second fact to lean on.
    expect(filedByWithdrawnRequest({ ...artifact, run: { ...run, trigger: null } })).toBe(false);
    expect(filedByWithdrawnRequest({ ...artifact, run: null })).toBe(false);
  });

  it("only files a finished, unsent draft", () => {
    expect(filedByWithdrawnRequest({ ...artifact, run, status: "running" })).toBe(false);
    expect(filedByWithdrawnRequest({ ...artifact, run, status: "reviewed" })).toBe(false);
    expect(
      filedByWithdrawnRequest({
        ...artifact,
        run,
        sent: { at: "2026-08-20T16:00:00Z", event: "COMMENT", url: null, auto: false },
      }),
    ).toBe(false);
  });
});

describe("the tap on the machine when a PR lands", () => {
  const daemonKnobs = {
    poll: true,
    autoReview: true,
    notify: true,
    intervalMinutes: 5,
    parallel: 1,
    repos: [],
  };

  const options = {
    repos: [],
    intervalMs: 10,
    parallel: 1,
    autoReview: false,
    notify: true,
    autoSend: "shadow" as const,
    autoSendThreshold: 90,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CERBER_HOME = mkdtempSync(path.join(os.tmpdir(), "cerber-daemon-"));
    config.mockResolvedValue({ trust: [], daemon: daemonKnobs });
    login.mockResolvedValue("me");
    conversation.mockResolvedValue([]);
    ownReview.mockResolvedValue(null);
    notified.mockResolvedValue(true);
  });

  async function pollTimes(polls: number) {
    const handle = startDaemon(options);
    try {
      await vi.waitFor(() => expect(handle.status().polls).toBeGreaterThanOrEqual(polls));
      return handle.status();
    } finally {
      await stopAndDrain(handle);
    }
  }

  it("announces the PR the poll just discovered", async () => {
    search.mockResolvedValue([DISCOVERED]);
    await pollTimes(1);
    expect(notified).toHaveBeenCalledWith({
      title: "widgets#7 awaits your review",
      body: "feat: add sprockets — someone",
    });
  });

  it("folds one poll's arrivals into one interruption", async () => {
    search.mockResolvedValue([DISCOVERED, { ...DISCOVERED, number: 8 }]);
    await pollTimes(1);
    expect(notified).toHaveBeenCalledTimes(1);
    expect(notified.mock.calls[0]![0].title).toBe("2 PRs await your review");
  });

  // The artifact is the ledger: a PR that already has one is not news, which is
  // what stops every poll re-announcing the same queue.
  it("says nothing about a PR it has already stubbed", async () => {
    search.mockResolvedValue([DISCOVERED]);
    await pollTimes(3);
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when the machine's own notification is switched off", async () => {
    config.mockResolvedValue({ trust: [], daemon: { ...daemonKnobs, notify: false } });
    search.mockResolvedValue([DISCOVERED]);
    await pollTimes(1);
    expect(notified).not.toHaveBeenCalled();
  });

  it("costs the poll nothing when the machine has no notifier", async () => {
    notified.mockResolvedValue(false);
    search.mockResolvedValue([DISCOVERED]);
    const status = await pollTimes(2);
    expect(status.awaiting.map((a) => a.id)).toEqual(["acme/widgets#7"]);
    expect(status.lastPollError).toBeNull();
  });

  // The failure this whole feature is meant to avoid: the daemon claiming the
  // job, the cockpit standing down for it, and nobody announcing the PR.
  it("hands the job back when the machine turns out to have no notifier", async () => {
    notified.mockResolvedValue(false);
    search.mockResolvedValue([DISCOVERED]);
    expect((await pollTimes(1)).notify).toBe(false);
  });

  it("takes it back again once the notifier answers", async () => {
    notified.mockResolvedValueOnce(false).mockResolvedValue(true);
    // Two PRs, one per poll, so the second poll has an arrival to try with.
    search.mockResolvedValueOnce([DISCOVERED]).mockResolvedValue([DISCOVERED, { ...DISCOVERED, number: 8 }]);
    expect((await pollTimes(2)).notify).toBe(true);
  });

  // What the cockpit's bell reads to know it would be a second popup.
  it("tells the cockpit whether it is announcing arrivals itself", async () => {
    search.mockResolvedValue([DISCOVERED]);
    expect((await pollTimes(1)).notify).toBe(true);

    config.mockResolvedValue({ trust: [], daemon: { ...daemonKnobs, poll: false } });
    // A loop that isn't polling discovers nothing, so it promises nothing.
    expect((await pollTimes(1)).notify).toBe(false);
  });
});

describe("a review you settled, and were asked for again", () => {
  const daemonKnobs = {
    poll: true,
    autoReview: true,
    notify: true,
    intervalMinutes: 5,
    parallel: 1,
    repos: [],
  };
  // autoReview off: what's under test is the queue's bookkeeping, not the runner.
  const options = {
    repos: [],
    intervalMs: 10,
    parallel: 1,
    autoReview: false,
    notify: false,
    autoSend: "shadow" as const,
    autoSendThreshold: 90,
  };

  const RUN = {
    model: "claude",
    startedAt: "2026-08-24T09:10:00Z",
    finishedAt: "2026-08-24T09:17:00Z",
    costUsd: 6.8,
    error: null,
    withSource: true,
    trusted: true,
    sessionId: null,
    trigger: "daemon" as const,
    reviewedSha: "abc1234",
  };

  /** A draft you skipped at a known moment — the row this whole change is about. */
  const settled = (over: Record<string, unknown> = {}) => ({
    ...stubArtifact(DISCOVERED),
    status: "skipped" as const,
    run: RUN,
    settledAt: "2026-08-24T10:00:00Z",
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CERBER_HOME = mkdtempSync(path.join(os.tmpdir(), "cerber-daemon-reopen-"));
    config.mockResolvedValue({ trust: [], daemon: daemonKnobs });
    login.mockResolvedValue("me");
    conversation.mockResolvedValue([]);
    lastRequest.mockResolvedValue(null);
    // GitHub is asking for this one right now — every case here starts there.
    search.mockResolvedValue([DISCOVERED]);
  });

  async function pollOnce() {
    const handle = startDaemon(options);
    try {
      await vi.waitFor(() => expect(handle.status().polls).toBeGreaterThanOrEqual(1));
    } finally {
      await stopAndDrain(handle);
    }
    return loadArtifact("acme/widgets#7");
  }

  it("puts the row back in the inbox when the ask came after your skip", async () => {
    await saveArtifact(settled());
    lastRequest.mockResolvedValue("2026-08-24T12:41:22Z");

    const after = await pollOnce();
    expect(after?.status).toBe("ready");
    // The stamp goes with the decision it dated: this row is not settled now.
    expect(after?.settledAt).toBeNull();
    // The draft itself is untouched — it is the same review, back on your desk.
    expect(after?.run?.reviewedSha).toBe("abc1234");
  });

  it("leaves your skip standing when the ask is the one you already answered", async () => {
    await saveArtifact(settled());
    lastRequest.mockResolvedValue("2026-08-21T10:43:27Z");

    const after = await pollOnce();
    expect(after?.status).toBe("skipped");
    expect(after?.settledAt).toBe("2026-08-24T10:00:00Z");
  });

  // The request left open by a skip is the ordinary case — a row you dealt with
  // that GitHub never stopped asking about. Nothing to undo, nothing to say.
  it("says nothing about a request that predates nothing", async () => {
    await saveArtifact(settled());
    lastRequest.mockResolvedValue(null);

    expect((await pollOnce())?.status).toBe("skipped");
  });

  it("drops cerber's own account of why the row was settled", async () => {
    // Filed by the poll, not by you: the note explains a status that is going.
    await saveArtifact(
      settled({
        status: "reviewed" as const,
        settledAt: "2026-08-24T10:00:00Z",
        filed: { at: "2026-08-24T10:00:00Z", reason: "request-withdrawn" as const, review: null, reply: null },
      }),
    );
    lastRequest.mockResolvedValue("2026-08-24T12:41:22Z");

    const after = await pollOnce();
    expect(after?.status).toBe("ready");
    expect(after?.filed).toBeNull();
  });

  it("reopens a row with no draft as awaiting one", async () => {
    await saveArtifact(settled({ run: null }));
    lastRequest.mockResolvedValue("2026-08-24T12:41:22Z");

    expect((await pollOnce())?.status).toBe("awaiting");
  });

  it("never reopens a review that was sent", async () => {
    await saveArtifact(
      settled({
        status: "sent" as const,
        sent: { at: "2026-08-24T10:00:00Z", event: "COMMENT" as const, url: null, auto: false },
      }),
    );
    lastRequest.mockResolvedValue("2026-08-24T12:41:22Z");

    const after = await pollOnce();
    expect(after?.status).toBe("sent");
    expect(lastRequest).not.toHaveBeenCalled();
  });

  // One GitHub call per poll per settled row is the whole cost of this; a row
  // that could never be reopened must not cost even that.
  it("asks GitHub nothing about a row that isn't settled", async () => {
    await saveArtifact({ ...stubArtifact(DISCOVERED), status: "ready" as const, run: RUN });

    expect((await pollOnce())?.status).toBe("ready");
    expect(lastRequest).not.toHaveBeenCalled();
  });

  it("leaves the row alone when GitHub cannot be reached", async () => {
    await saveArtifact(settled());
    lastRequest.mockRejectedValue(new Error("gh api graphql failed: offline"));

    expect((await pollOnce())?.status).toBe("skipped");
  });
});

describe("askedAgainAfterSettling", () => {
  const RUN = {
    model: null,
    startedAt: "2026-08-24T09:10:00Z",
    finishedAt: "2026-08-24T09:17:00Z",
    costUsd: null,
    error: null,
    withSource: false,
    trusted: false,
    sessionId: null,
    trigger: "daemon" as const,
    reviewedSha: null,
  };
  const skipped = {
    ...stubArtifact(DISCOVERED),
    status: "skipped" as const,
    run: RUN,
    settledAt: "2026-08-24T10:00:00Z",
  };

  it("only counts an ask that came after the decision", () => {
    expect(askedAgainAfterSettling(skipped, "2026-08-24T12:41:22Z")).toBe(true);
    expect(askedAgainAfterSettling(skipped, "2026-08-24T09:00:00Z")).toBe(false);
    expect(askedAgainAfterSettling(skipped, null)).toBe(false);
  });

  // Same second on both sides: our stamps carry milliseconds and GitHub's do
  // not, and "…:00.500Z" sorts before "…:00Z" as text.
  it("compares moments, not strings", () => {
    const settledAt = "2026-08-24T10:00:26.500Z";
    expect(askedAgainAfterSettling({ ...skipped, settledAt }, "2026-08-24T10:00:26Z")).toBe(false);
    expect(askedAgainAfterSettling({ ...skipped, settledAt }, "2026-08-24T10:00:27Z")).toBe(true);
  });

  it("has nothing to undo on a row you never settled", () => {
    expect(askedAgainAfterSettling({ ...skipped, status: "ready" }, "2026-08-24T12:41:22Z")).toBe(false);
    expect(askedAgainAfterSettling({ ...skipped, status: "running" }, "2026-08-24T12:41:22Z")).toBe(false);
  });

  it("never speaks for a review that was sent", () => {
    const sent = {
      ...skipped,
      status: "reviewed" as const,
      sent: { at: "2026-08-24T10:00:00Z", event: "COMMENT" as const, url: null, auto: false },
    };
    expect(askedAgainAfterSettling(sent, "2026-08-24T12:41:22Z")).toBe(false);
  });

  // Rows settled before `settledAt` existed still have to be reachable, or the
  // bug this fixes is permanent for every one of them.
  it("dates a legacy row by the latest moment it can prove", () => {
    const legacy = { ...skipped, settledAt: null };
    // You cannot have skipped a draft before the draft existed.
    expect(settledAtOf(legacy)).toBe(RUN.finishedAt);
    expect(askedAgainAfterSettling(legacy, "2026-08-24T12:41:22Z")).toBe(true);
    expect(askedAgainAfterSettling(legacy, "2026-08-24T09:15:00Z")).toBe(false);

    // Cerber filing it is a later, better-known moment than the run finishing.
    const filed = {
      ...legacy,
      status: "reviewed" as const,
      filed: { at: "2026-08-24T13:00:00Z", reason: "own-review" as const, review: null, reply: null },
    };
    expect(settledAtOf(filed)).toBe("2026-08-24T13:00:00Z");
    expect(askedAgainAfterSettling(filed, "2026-08-24T12:41:22Z")).toBe(false);

    // Nothing to go on at all: a stub you skipped before it was ever drafted.
    expect(settledAtOf({ ...legacy, run: null })).toBeNull();
  });

  it("sends a row back to the draft it has, or to waiting for one", () => {
    expect(reopenedStatus(skipped)).toBe("ready");
    expect(reopenedStatus({ ...skipped, run: null })).toBe("awaiting");
    expect(reopenedStatus({ ...skipped, run: { ...RUN, error: "claude exited 1" } })).toBe("awaiting");
    expect(reopenedStatus({ ...skipped, run: { ...RUN, finishedAt: null } })).toBe("awaiting");
  });
});
