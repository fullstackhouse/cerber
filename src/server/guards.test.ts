import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Mock, beforeEach, describe, expect, it, vi } from "vitest";
import { Artifact, ArtifactStatus, PrInfo, SCHEMA_VERSION } from "../core/artifact.js";
import { currentLogin, fetchPrDiff, fetchPrInfo, submitReview } from "../core/gh.js";
import { loadArtifact, saveArtifact, updateArtifactByKey } from "../core/state.js";
import { beginReview, endReview } from "../runner/inflight.js";
import { reviewPr } from "../runner/review.js";
import { buildApp } from "./index.js";

// The only GitHub write that speaks as a review. Stubbed so a test can assert it was
// *not* called, which is the whole subject of half this file.
vi.mock("../core/gh.js", async (orig) => ({
  ...(await orig<typeof import("../core/gh.js")>()),
  submitReview: vi.fn(),
  fetchPrInfo: vi.fn(),
  fetchPrDiff: vi.fn(),
  currentLogin: vi.fn(),
}));
vi.mock("../runner/review.js", () => ({ reviewPr: vi.fn(), pool: vi.fn() }));

const submit = submitReview as Mock;
const prInfo = fetchPrInfo as Mock;
const prDiff = fetchPrDiff as Mock;
const login = currentLogin as Mock;

const home = mkdtempSync(path.join(os.tmpdir(), "cerber-guards-"));
process.env.CERBER_HOME = home;

const ID = "acme/widgets#42";
const KEY = "acme__widgets__42";

function pr(): PrInfo {
  return {
    owner: "acme",
    repo: "widgets",
    number: 42,
    title: "Add a thing",
    url: "https://github.com/acme/widgets/pull/42",
    author: "someone",
    body: "",
    baseRefName: "main",
    headRefName: "f",
    headSha: "abc",
    state: "OPEN",
    isDraft: false,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
  };
}

function artifact(status: ArtifactStatus): Artifact {
  const now = "2026-08-21T10:00:00.000Z";
  return {
    schemaVersion: SCHEMA_VERSION,
    id: ID,
    status,
    createdAt: now,
    updatedAt: now,
    pr: pr(),
    diff: "--- a\n+++ b\n",
    summary: "a draft",
    chapters: [],
    comments: [],
    verdict: { recommendation: "approve", confidence: 90, reasoning: "fine" },
    bodyOverride: null,
    run: null,
    sent: null,
    priorSends: [],
    filed: null,
    handoff: null,
    raisedCheck: null,
    settledAt: null,
    refresh: null,
    calibration: null,
    chat: [],
    preChat: null,
    pendingChat: null,
  };
}

const send = async (event = "APPROVE") => {
  const app = await buildApp({});
  return app.request(`/api/reviews/${KEY}/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event, confirm: true }),
  });
};

const patchStatus = async (status: string) => {
  const app = await buildApp({});
  return app.request(`/api/reviews/${KEY}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
};

const patchBody = async (body: Record<string, unknown>) => {
  const app = await buildApp({});
  return app.request(`/api/reviews/${KEY}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  submit.mockResolvedValue({ url: "https://github.com/acme/widgets/pull/42#r1" });
  login.mockResolvedValue("me");
});

describe("POST /api/reviews/:key/send — not while a run is rewriting the draft", () => {
  it("refuses when the artifact says a run is in flight", async () => {
    // Cross-process: a `cerber review` in another terminal is invisible to this
    // one's in-memory claim, so the persisted status has to carry the answer.
    await saveArtifact(artifact("running"));

    const res = await send();
    expect(res.status).toBe(409);
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses when this process is running one", async () => {
    // And the mirror: a run this process started moments ago may not have
    // written anything yet, so the in-memory claim has to carry that one.
    await saveArtifact(artifact("ready"));
    beginReview(ID);
    try {
      const res = await send();
      expect(res.status).toBe(409);
      expect(submit).not.toHaveBeenCalled();
    } finally {
      endReview(ID);
    }
  });

  it("still sends a finished draft", async () => {
    await saveArtifact(artifact("ready"));

    const res = await send();
    expect(res.status).toBe(200);
    expect(submit).toHaveBeenCalledOnce();
    expect((await loadArtifact(ID))!.status).toBe("sent");
  });

  it("sends a draft that replaced one already on the PR", async () => {
    // The other half of the stand-down rules: auto-send and a handoff both
    // refuse a row with a prior send, and Send deliberately does not. Without
    // this, making the send guard read the whole record — the obvious
    // symmetry with its two siblings — would silently make a re-reviewed
    // review unsendable, which is the entire point of the feature.
    await saveArtifact({
      ...artifact("ready"),
      priorSends: [{ at: "2026-08-20T09:00:00.000Z", url: "u", event: "COMMENT" as const, auto: false }],
    });

    const res = await send();
    expect(res.status).toBe(200);
    expect(submit).toHaveBeenCalledOnce();
    const after = (await loadArtifact(ID))!;
    expect(after.status).toBe("sent");
    expect(after.priorSends).toHaveLength(1);
  });

  it("refuses a second submission of one already sent", async () => {
    await saveArtifact(artifact("ready"));
    expect((await send()).status).toBe(200);

    const again = await send();
    expect(again.status).toBe(409);
    expect(submit).toHaveBeenCalledOnce();
  });
});

describe("POST /api/reviews/:key/send — your own PR takes a comment only", () => {
  const mine = () => ({ ...artifact("ready"), pr: { ...pr(), author: "Me" } });

  it.each(["APPROVE", "REQUEST_CHANGES"])("refuses %s before anything reaches GitHub", async (event) => {
    await saveArtifact(mine());
    const res = await send(event);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("your own PR");
    expect(submit).not.toHaveBeenCalled();
    expect((await loadArtifact(ID))!.status).toBe("ready");
  });

  it("sends a comment", async () => {
    await saveArtifact(mine());
    const res = await send("COMMENT");
    expect(res.status).toBe(200);
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0]![1].event).toBe("COMMENT");
  });

  it("leaves somebody else's PR alone, and GitHub the last word when gh cannot say who you are", async () => {
    await saveArtifact(artifact("ready"));
    expect((await send("APPROVE")).status).toBe(200);

    await saveArtifact(mine());
    login.mockRejectedValue(new Error("gh: not authenticated"));
    expect((await send("APPROVE")).status).toBe(200);
  });
});

describe("GET /api/reviews/:key — whether it is yours", () => {
  it("says so on the review's own read", async () => {
    await saveArtifact({ ...artifact("ready"), pr: { ...pr(), author: "me" } });
    const app = await buildApp({});
    expect(((await (await app.request(`/api/reviews/${KEY}`)).json()) as { own: boolean }).own).toBe(true);
  });
});

describe("GET /api/reviews — never held up by gh", () => {
  it("answers without the login when gh does not, marking nothing as yours", async () => {
    login.mockReturnValue(new Promise(() => {}));
    await saveArtifact({ ...artifact("awaiting"), pr: { ...pr(), author: "me" } });
    const app = await buildApp({});
    const rows = (await (await app.request("/api/reviews")).json()) as { id: string; own: boolean }[];
    expect(rows.find((r) => r.id === ID)?.own).toBe(false);
  }, 5000);
});

describe("GET /api/reviews — which rows are yours", () => {
  it("marks a PR you opened as own, and nobody else's", async () => {
    await saveArtifact({ ...artifact("awaiting"), pr: { ...pr(), author: "me" } });
    await saveArtifact({ ...artifact("ready"), id: "acme/widgets#43", pr: { ...pr(), number: 43 } });
    const app = await buildApp({});
    const rows = (await (await app.request("/api/reviews")).json()) as { id: string; own: boolean }[];
    expect(rows.find((r) => r.id === ID)?.own).toBe(true);
    expect(rows.find((r) => r.id === "acme/widgets#43")?.own).toBe(false);
  });
});

describe("PATCH /api/reviews/:key — only the statuses that are your decision", () => {
  it("accepts reviewed and skipped", async () => {
    for (const status of ["reviewed", "skipped"]) {
      await saveArtifact(artifact("ready"));
      const res = await patchStatus(status);
      expect(res.status).toBe(200);
      expect((await loadArtifact(ID))!.status).toBe(status);
    }
  });

  // The poll asks which side of your decision a review request falls on, so the
  // decision has to be dated as it is made. `updatedAt` cannot answer it: just
  // opening a settled review refreshes it and moves that field forward.
  it("dates the decision as it makes it", async () => {
    await saveArtifact(artifact("ready"));
    expect((await loadArtifact(ID))!.settledAt).toBeNull();

    const before = Date.now();
    expect((await patchStatus("skipped")).status).toBe(200);

    const at = (await loadArtifact(ID))!.settledAt;
    expect(at).not.toBeNull();
    expect(Date.parse(at!)).toBeGreaterThanOrEqual(before);
  });

  // `filed` outranks the status wherever the queue tags a row, on the grounds
  // that "reviewed" would read as a click nobody made. Clicking makes it a
  // click — so cerber's account of the row goes with the status it explained.
  it("drops cerber's filing note when you settle the row yourself", async () => {
    await saveArtifact({
      ...artifact("reviewed"),
      filed: { at: "2026-08-21T09:00:00.000Z", reason: "own-review" as const, review: null, reply: null },
    });

    expect((await patchStatus("skipped")).status).toBe(200);

    const after = (await loadArtifact(ID))!;
    expect(after.status).toBe("skipped");
    expect(after.filed).toBeNull();
  });

  it("refuses to call a review sent when nothing was sent", async () => {
    // The row this used to make claims a review reached GitHub while `sent` is
    // still null — a state no honest path produces, which the queue and every
    // guard keyed on the record then read two different ways.
    await saveArtifact(artifact("ready"));

    const res = await patchStatus("sent");
    expect(res.status).toBe(400);
    const after = (await loadArtifact(ID))!;
    expect(after.status).toBe("ready");
    expect(after.sent).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses the statuses the runner owns", async () => {
    for (const status of ["running", "ready", "failed", "awaiting"]) {
      await saveArtifact(artifact("ready"));
      expect((await patchStatus(status)).status).toBe(400);
    }
  });

  // The review's own comment, written by hand. It is the one thing GitHub gets
  // that is not derived from the draft, so it is stored rather than composed —
  // and `null` is how the user hands the body back to the composition.
  it("takes a body the user wrote, and gives it back on null", async () => {
    await saveArtifact(artifact("ready"));

    expect((await patchBody({ bodyOverride: "Ran it locally, ship it." })).status).toBe(200);
    expect((await loadArtifact(ID))!.bodyOverride).toBe("Ran it locally, ship it.");
    // The draft it replaces is untouched — this changes what posts, not the review.
    expect((await loadArtifact(ID))!.summary).toBe("a draft");

    expect((await patchBody({ bodyOverride: null })).status).toBe(200);
    expect((await loadArtifact(ID))!.bodyOverride).toBeNull();
    // Settling is the other half of this route; writing a body is not a settle.
    expect((await loadArtifact(ID))!.status).toBe("ready");
    expect((await loadArtifact(ID))!.settledAt).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  // Coercion would be worse than a refusal here: `String({})` is
  // "[object Object]", and this field is posted to GitHub verbatim.
  it("refuses a body that is not a string", async () => {
    await saveArtifact(artifact("ready"));

    for (const value of [{ a: 1 }, ["x"], true, 7]) {
      expect((await patchBody({ bodyOverride: value })).status).toBe(400);
    }
    expect((await loadArtifact(ID))!.bodyOverride).toBeNull();
  });
});

// The refresh handler reads the row, then spends seconds on GitHub before
// writing what it computed. Anything that touched the row in between owns it.
describe("POST /api/reviews/:key/refresh — not over a row that moved underneath", () => {
  const refresh = async () => {
    const app = await buildApp({});
    return app.request(`/api/reviews/${KEY}/refresh`, { method: "POST" });
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    // A moved head, so the handler considers the row stale and goes on to fetch.
    prInfo.mockResolvedValue({ ...pr(), headSha: "def" });
    await saveArtifact(artifact("ready"));
  });

  it("declines when a run finished while it was fetching, keeping that draft", async () => {
    prDiff.mockImplementation(async () => {
      // A whole run: started after the snapshot above, done before the write.
      await updateArtifactByKey(KEY, (a) => ({ ...a, summary: "a fresher draft" }));
      return "--- a\n+++ b\n";
    });

    const res = await refresh();
    expect(res.status).toBe(200);
    expect((await res.json()).changed).toBe(false);
    expect((await loadArtifact(ID))!.summary).toBe("a fresher draft");
  });

  it("still refreshes a row nothing else touched", async () => {
    prDiff.mockResolvedValue("--- a\n+++ b\n");

    const res = await refresh();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stale).toBe(true);
    expect(body.headSha).toBe("def");
    expect((await loadArtifact(ID))!.pr.headSha).toBe("def");
  });

  it("declines a sent row but still reports where the PR is", async () => {
    // A posted review is never re-anchored, so nothing is written — and then
    // `headSha` is the only thing the answer carries. The cockpit's "the PR
    // moved on since you sent this" banner is built from it and from `stale`,
    // and without them a sent review goes stale with nothing saying so.
    await saveArtifact({
      ...artifact("sent"),
      sent: { at: "2026-08-21T10:00:00.000Z", url: "u", event: "COMMENT" as const, auto: false },
    });

    const res = await refresh();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ stale: true, changed: false, headSha: "def" });
    // Untouched: the draft on disk is still the one that was posted.
    expect((await loadArtifact(ID))!.pr.headSha).toBe("abc");
  });
});

describe("PUT /api/reviews/:key/viewed — reading progress", () => {
  const putViewed = async (body: Record<string, unknown>) => {
    const app = await buildApp({});
    return app.request(`/api/reviews/${KEY}/viewed`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  };

  it("marks and unmarks a file", async () => {
    await saveArtifact(artifact("ready"));
    expect((await putViewed({ path: "src/a.ts", fingerprint: "0badf00d" })).status).toBe(200);
    expect((await loadArtifact(ID))!.viewed).toEqual({ "src/a.ts": "0badf00d" });
    expect((await putViewed({ path: "src/a.ts", fingerprint: null })).status).toBe(200);
    expect((await loadArtifact(ID))!.viewed).toEqual({});
  });

  it("still takes a mark on a review already sent", async () => {
    await saveArtifact({ ...artifact("sent"), sent: { at: "2026-08-21T10:00:00.000Z", url: null, event: "APPROVE", auto: false } });
    expect((await putViewed({ path: "src/a.ts", fingerprint: "0badf00d" })).status).toBe(200);
  });

  it("refuses a body it cannot store", async () => {
    await saveArtifact(artifact("ready"));
    expect((await putViewed({ path: "", fingerprint: "x" })).status).toBe(400);
    expect((await putViewed({ path: "src/a.ts", fingerprint: 7 })).status).toBe(400);
    const app = await buildApp({});
    for (const body of ["not json", "null"]) {
      const res = await app.request(`/api/reviews/${KEY}/viewed`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("POST /api/reviews/:key/rerun — the only way back into a sent review", () => {
  const rerun = async () => {
    const app = await buildApp({});
    return app.request(`/api/reviews/${KEY}/rerun`, { method: "POST" });
  };

  /** A row whose draft is on GitHub, with the run that produced it recorded. */
  const SENT_RUN = {
    model: "claude-opus",
    startedAt: "2026-08-21T09:00:00.000Z",
    finishedAt: "2026-08-21T09:05:00.000Z",
    costUsd: 0.42,
    error: null,
    withSource: true,
    trusted: false,
    sessionId: null,
    trigger: "user" as const,
    reviewedSha: "abc1234",
  };

  const sentRow = () => ({
    ...artifact("sent"),
    sent: { at: "2026-08-21T10:00:00.000Z", url: "u", event: "COMMENT" as const, auto: false },
    run: SENT_RUN,
  });

  beforeEach(() => {
    prInfo.mockResolvedValue(pr());
    prDiff.mockResolvedValue("--- a\n+++ b\n");
    (reviewPr as Mock).mockResolvedValue({ artifact: artifact("ready"), skipped: false });
  });

  it("starts a run on a review that was already sent", async () => {
    // It used to refuse with a 409, which left the cockpit no move at all on a
    // PR whose author had pushed since: the review on GitHub answers a commit
    // that is gone, and only a new draft answers the new one.
    await saveArtifact(sentRow());

    const res = await rerun();
    expect(res.status).toBe(202);
    expect(reviewPr).toHaveBeenCalledWith(expect.objectContaining({ number: 42 }), expect.objectContaining({ force: true }));
  });

  it("holds on to the send, and its run, until the claim replaces the draft", async () => {
    // The runner archives the send (`supersede`) at the moment it replaces the
    // draft; until then the draft on the row is still the one that was sent,
    // and so is the run block describing what produced it. A stub written here
    // would erase that review's model, cost and commit minutes before the
    // claim writes a real one — and for good, if the run never gets there.
    await saveArtifact(sentRow());

    expect((await rerun()).status).toBe(202);
    const after = (await loadArtifact(ID))!;
    expect(after.status).toBe("running");
    expect(after.sent).not.toBeNull();
    expect(after.run).toEqual(SENT_RUN);
  });

  it("puts a sent row back under sent when the run dies before claiming it", async () => {
    // "failed" would hide a review that really is on GitHub behind a re-review
    // that never produced anything. The failure is the re-review's, so it goes
    // in the history — writing it onto `run.error` would pin it on the run
    // that produced the review actually sitting on the PR.
    await saveArtifact(sentRow());
    (reviewPr as Mock).mockRejectedValue(new Error("gh is down"));

    expect((await rerun()).status).toBe(202);
    await vi.waitFor(async () => {
      const after = (await loadArtifact(ID))!;
      expect(after.status).toBe("sent");
      expect(after.sent).not.toBeNull();
      expect(after.run).toEqual(SENT_RUN);
      expect(after.history?.at(-1)?.what).toBe("re-review did not start: gh is down");
    });
  });

  it("still fails an unsent row that cannot start", async () => {
    await saveArtifact(artifact("ready"));
    (reviewPr as Mock).mockRejectedValue(new Error("gh is down"));

    expect((await rerun()).status).toBe(202);
    await vi.waitFor(async () => {
      expect((await loadArtifact(ID))!.status).toBe("failed");
    });
  });

  it("refuses while a run is already in flight", async () => {
    await saveArtifact(sentRow());
    beginReview(ID);
    try {
      expect((await rerun()).status).toBe(409);
      expect(reviewPr).not.toHaveBeenCalled();
    } finally {
      endReview(ID);
    }
  });
});
