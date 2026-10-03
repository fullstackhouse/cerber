import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Mock, beforeEach, describe, expect, it, vi } from "vitest";
import { Artifact, ArtifactStatus, PrInfo, SCHEMA_VERSION } from "../core/artifact.js";
import {
  currentLogin,
  fetchAssignableUsers,
  handOffReview,
  postIssueComment,
  submitReview,
} from "../core/gh.js";
import { loadArtifact, saveArtifact, updateArtifactByKey } from "../core/state.js";
import { buildApp } from "./index.js";

// The handoff's two writes, and the login it needs to know who to take off.
// Stubbed so the tests can assert on what was *not* called, which is most of
// what there is to get wrong here.
vi.mock("../core/gh.js", async (orig) => ({
  ...(await orig<typeof import("../core/gh.js")>()),
  handOffReview: vi.fn(),
  postIssueComment: vi.fn(),
  fetchAssignableUsers: vi.fn(),
  submitReview: vi.fn(),
  currentLogin: vi.fn(),
  fetchPrInfo: vi.fn(),
  fetchPrDiff: vi.fn(),
}));
vi.mock("../runner/review.js", () => ({ reviewPr: vi.fn(), pool: vi.fn() }));

const swap = handOffReview as Mock;
const comment = postIssueComment as Mock;
const login = currentLogin as Mock;
const assignable = fetchAssignableUsers as Mock;
const submit = submitReview as Mock;

const home = mkdtempSync(path.join(os.tmpdir(), "cerber-handoff-"));
process.env.CERBER_HOME = home;

const ID = "acme/widgets#42";
const KEY = "acme__widgets__42";
const REF = { owner: "acme", repo: "widgets", number: 42 };

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

function artifact(over: Partial<Artifact> = {}): Artifact {
  const now = "2026-08-21T10:00:00.000Z";
  return {
    schemaVersion: SCHEMA_VERSION,
    id: ID,
    status: "ready" as ArtifactStatus,
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
    filed: null,
    handoff: null,
    settledAt: null,
    refresh: null,
    calibration: null,
    chat: [],
    preChat: null,
    pendingChat: null,
    ...over,
  };
}

const handoff = async (body: Record<string, unknown>) => {
  const app = await buildApp({});
  return app.request(`/api/reviews/${KEY}/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
};

beforeEach(async () => {
  vi.clearAllMocks();
  login.mockResolvedValue("jacek");
  swap.mockResolvedValue({ withdrewYours: true, withdrawError: null });
  comment.mockResolvedValue({ url: "https://github.com/acme/widgets/pull/42#c1" });
  assignable.mockResolvedValue(["maks", "jacek", "someone", "ada"]);
  submit.mockResolvedValue({ url: "https://github.com/acme/widgets/pull/42#r1" });
  const { promises: fs } = await import("node:fs");
  await fs.rm(path.join(home, "reviews"), { recursive: true, force: true });
});

describe("POST /api/reviews/:key/handoff — giving a review away", () => {
  it("moves the request, posts the note, and settles the row", async () => {
    await saveArtifact(artifact());
    const res = await handoff({ to: "maks", note: "@maks — over to you.", confirm: true });
    expect(res.status).toBe(200);

    expect(swap).toHaveBeenCalledWith(REF, "maks", "jacek");
    expect(comment).toHaveBeenCalledWith(REF, "@maks — over to you.");

    const saved = await loadArtifact(ID);
    expect(saved?.status).toBe("skipped");
    expect(saved?.settledAt).toBeTruthy();
    expect(saved?.handoff).toMatchObject({
      to: "maks",
      withdrewYours: true,
      note: { body: "@maks — over to you.", url: "https://github.com/acme/widgets/pull/42#c1" },
    });
    expect((await res.json()).noteError).toBeNull();
  });

  it("writes the handoff into the review's own history", async () => {
    await saveArtifact(artifact());
    await handoff({ to: "maks", note: "over to you", confirm: true });
    const saved = await loadArtifact(ID);
    expect(saved?.history?.map((h) => h.what).join("\n")).toContain("handed to @maks");
  });

  it("posts nothing when the note is blank — the request still moves", async () => {
    await saveArtifact(artifact());
    const res = await handoff({ to: "maks", note: "   ", confirm: true });
    expect(res.status).toBe(200);
    expect(swap).toHaveBeenCalled();
    expect(comment).not.toHaveBeenCalled();
    expect((await loadArtifact(ID))?.handoff?.note).toBeNull();
  });

  it("accepts the name as people write it", async () => {
    await saveArtifact(artifact());
    await handoff({ to: " @maks ", confirm: true });
    expect(swap).toHaveBeenCalledWith(REF, "maks", "jacek");
  });

  it("leaves the row and the PR alone when the request could not be moved", async () => {
    // The swap goes first precisely so its refusal costs nothing: no note on the
    // PR about a handoff that didn't happen, and no row claiming it did.
    await saveArtifact(artifact());
    swap.mockRejectedValue(new Error("Reviews may only be requested from collaborators."));
    const res = await handoff({ to: "stranger", note: "over to you", confirm: true });
    expect(res.status).toBe(502);
    expect(comment).not.toHaveBeenCalled();
    const saved = await loadArtifact(ID);
    expect(saved?.status).toBe("ready");
    expect(saved?.handoff).toBeNull();
  });

  it("records the handoff anyway when only the note failed, and says so", async () => {
    // By this point @maks is being asked for the review whether or not the
    // conversation says why — so the row must not pretend otherwise.
    await saveArtifact(artifact());
    comment.mockRejectedValue(new Error("gh: Issues are disabled (HTTP 410)"));
    const res = await handoff({ to: "maks", note: "over to you", confirm: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.noteError).toContain("410");
    const saved = await loadArtifact(ID);
    expect(saved?.status).toBe("skipped");
    expect(saved?.handoff).toMatchObject({ to: "maks", note: null });
  });

  it("keeps a sent row under sent, and records the handoff on top", async () => {
    // A send is the stronger fact about the row and already took it out of the
    // queue. Overwriting the status would claim no review was ever sent.
    await saveArtifact(
      artifact({
        status: "sent",
        sent: { at: "2026-08-21T11:00:00.000Z", event: "COMMENT", url: null, auto: false },
      }),
    );
    const res = await handoff({ to: "maks", confirm: true });
    expect(res.status).toBe(200);
    const saved = await loadArtifact(ID);
    expect(saved?.status).toBe("sent");
    expect(saved?.settledAt).toBeNull();
    expect(saved?.handoff?.to).toBe("maks");
  });

  it("clears cerber's own filing — the reason this row is settled is now yours", async () => {
    await saveArtifact(
      artifact({
        status: "reviewed",
        filed: { at: "2026-08-21T11:00:00.000Z", reason: "request-withdrawn", review: null, reply: null },
      }),
    );
    await handoff({ to: "maks", confirm: true });
    const saved = await loadArtifact(ID);
    expect(saved?.filed).toBeNull();
    expect(saved?.status).toBe("skipped");
  });

  it("does not ask GitHub to withdraw a request it already withdrew", async () => {
    // Handing on a second time. The withdrawal would fail, and the row would
    // then say you are still listed when the first handoff took you off.
    await saveArtifact(
      artifact({
        status: "skipped",
        handoff: { at: "2026-08-21T11:00:00.000Z", to: "maks", withdrewYours: true, note: null },
      }),
    );
    await handoff({ to: "ewa", confirm: true });
    expect(swap).toHaveBeenCalledWith(REF, "ewa", null);
    expect((await loadArtifact(ID))?.handoff?.to).toBe("ewa");
  });

  it("records a withdrawal that failed, instead of claiming it worked", async () => {
    // Everything that says "GitHub is asking both of you" reads this one flag,
    // so a route that hard-coded it true would silence every one of them.
    await saveArtifact(artifact());
    swap.mockResolvedValue({ withdrewYours: false, withdrawError: "gh: Not Found (HTTP 404)" });
    await handoff({ to: "maks", confirm: true });
    expect((await loadArtifact(ID))?.handoff?.withdrewYours).toBe(false);
  });

  it("tries the withdrawal again after one that failed", async () => {
    // The skip exists for a request already gone. One that was never removed is
    // still there, and passing null would leave you on the PR for good.
    await saveArtifact(
      artifact({
        status: "skipped",
        handoff: { at: "2026-08-21T11:00:00.000Z", to: "maks", withdrewYours: false, note: null },
      }),
    );
    await handoff({ to: "ewa", confirm: true });
    expect(swap).toHaveBeenCalledWith(REF, "ewa", "jacek");
  });

  it("refuses to hand a review to you", async () => {
    await saveArtifact(artifact());
    const res = await handoff({ to: "JACEK", confirm: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("is you");
    expect(swap).not.toHaveBeenCalled();
  });

  it("refuses a team — asking a room is not handing it to somebody", async () => {
    await saveArtifact(artifact());
    const res = await handoff({ to: "acme/reviewers", confirm: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("one GitHub login");
    expect(swap).not.toHaveBeenCalled();
  });

  it("refuses without an explicit confirmation", async () => {
    await saveArtifact(artifact());
    expect((await handoff({ to: "maks" })).status).toBe(400);
    expect(swap).not.toHaveBeenCalled();
  });

  it("does nothing at all when gh cannot say who you are", async () => {
    // Without that there is nobody to take off the PR, and a handoff that only
    // adds a reviewer leaves you on the hook while the row says otherwise.
    await saveArtifact(artifact());
    login.mockRejectedValue(new Error("gh: not authenticated"));
    const res = await handoff({ to: "maks", confirm: true });
    expect(res.status).toBe(502);
    expect(swap).not.toHaveBeenCalled();
    expect((await loadArtifact(ID))?.handoff).toBeNull();
  });

  it("refuses while the reviewer is answering a question about this review", async () => {
    // A chat turn's result is folded onto whatever the artifact says when it
    // lands, and that fold is written for a row nobody gave away mid-turn.
    await saveArtifact(
      artifact({
        pendingChat: {
          message: "why is this a blocker?",
          refs: [],
          startedAt: "2026-08-21T10:00:00.000Z",
          progress: [],
          error: null,
        },
      }),
    );
    const res = await handoff({ to: "maks", confirm: true });
    expect(res.status).toBe(409);
    expect(swap).not.toHaveBeenCalled();
  });

  it("takes a login with an underscore, which the suggestions can offer", async () => {
    // GitHub Enterprise Managed Users carry one, and `/assignees` returns them
    // — so refusing the shape meant offering a name the form would not send.
    await saveArtifact(artifact());
    const res = await handoff({ to: "mona_acme", confirm: true });
    expect(res.status).toBe(200);
    expect(swap).toHaveBeenCalledWith(REF, "mona_acme", "jacek");
  });

  it("refuses while a run is rewriting the draft", async () => {
    await saveArtifact(artifact({ status: "running" }));
    const res = await handoff({ to: "maks", confirm: true });
    expect(res.status).toBe(409);
    expect(swap).not.toHaveBeenCalled();
  });

  it("404s on a review it has never heard of", async () => {
    const app = await buildApp({});
    const res = await app.request("/api/reviews/nope__nope__1/handoff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "maks", confirm: true }),
    });
    expect(res.status).toBe(404);
    expect(swap).not.toHaveBeenCalled();
  });
});

describe("handing the draft over with it", () => {
  // A real hunk, so the comment anchors inline rather than folding into the
  // body — the inline path is the one that carries a grade onto GitHub.
  const DIFF = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1111111..2222222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -0,0 +1,2 @@",
    "+const a = 1;",
    "+const b = 2;",
    "",
  ].join("\n");

  const withComment = (over = {}) =>
    artifact({
      diff: DIFF,
      comments: [
        {
          id: "c1",
          path: "src/a.ts",
          line: 1,
          body: "this leaks",
          chapterId: null,
          severity: "blocker" as const,
          origin: "ai" as const,
          status: "draft" as const,
          originalLine: null,
          drifted: false,
          editedByUser: false,
        },
      ],
      ...over,
    });

  it("does not post the draft unless it was asked for", async () => {
    // A handoff is reachable from a row nobody has opened, where the draft is
    // whatever the poll wrote.
    await saveArtifact(withComment());
    await handoff({ to: "maks", confirm: true });
    expect(submit).not.toHaveBeenCalled();
    expect((await loadArtifact(ID))?.status).toBe("skipped");
  });

  it("sends it as a comment, never as the verdict it was drafted with", async () => {
    // Handing a PR over hands the judgement over with it, so an approve or a
    // change request here would be cerber ruling on a review it is giving away.
    await saveArtifact(
      withComment({ verdict: { recommendation: "request_changes", confidence: 90, reasoning: "no" } }),
    );
    const res = await handoff({ to: "maks", postReview: true, confirm: true });
    expect(res.status).toBe(200);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]?.[1].event).toBe("COMMENT");
    expect((await res.json()).sendError).toBeNull();
  });

  it("keeps the grades on the findings it posts", async () => {
    // The verdict is what is being handed over; what each finding *is* stays
    // exactly as the review graded it.
    await saveArtifact(withComment());
    await handoff({ to: "maks", postReview: true, confirm: true });
    expect(submit.mock.calls[0]?.[1].comments[0].body).toContain("blocker");
  });

  it("lands the row under sent, with the handoff on top of it", async () => {
    await saveArtifact(withComment());
    await handoff({ to: "maks", postReview: true, confirm: true });
    const saved = await loadArtifact(ID);
    expect(saved?.status).toBe("sent");
    expect(saved?.sent).toMatchObject({ event: "COMMENT", auto: false });
    expect(saved?.settledAt).toBeNull();
    expect(saved?.handoff?.to).toBe("maks");
    // The send's own record of what the AI proposed against what went.
    expect(saved?.calibration?.sentEvent).toBe("COMMENT");
  });

  it("hands off anyway when the review would not post, and says which half failed", async () => {
    // The request has moved by then. Rolling that back to tidy up a failed
    // submission would undo the half that worked.
    await saveArtifact(withComment());
    submit.mockRejectedValue(new Error("gh api reviews failed: Unprocessable Entity"));
    const res = await handoff({ to: "maks", note: "over to you", postReview: true, confirm: true });
    expect(res.status).toBe(200);
    expect((await res.json()).sendError).toContain("Unprocessable");
    const saved = await loadArtifact(ID);
    expect(saved?.status).toBe("skipped");
    expect(saved?.sent).toBeNull();
    expect(saved?.handoff).toMatchObject({ to: "maks", note: { body: "over to you" } });
  });

  it("does not submit over a send that landed while it was talking to GitHub", async () => {
    // The artifact was loaded before the request swap — two GitHub calls ago —
    // so the snapshot cannot see a Send from another tab or an auto-send. The
    // file can, and this is the second review on the PR if it doesn't look.
    await saveArtifact(withComment());
    const landed = { at: "2026-08-21T11:30:00.000Z", event: "APPROVE" as const, url: null, auto: true };
    swap.mockImplementation(async () => {
      await updateArtifactByKey(KEY, (a) => ({ ...a, status: "sent" as const, sent: landed }));
      return { withdrewYours: true, withdrawError: null };
    });
    const res = await handoff({ to: "maks", postReview: true, confirm: true });
    expect(res.status).toBe(200);
    expect(submit).not.toHaveBeenCalled();
    const saved = await loadArtifact(ID);
    expect(saved?.sent).toEqual(landed);
    expect(saved?.handoff?.to).toBe("maks");
  });

  it("will not post a review on a row that has nothing drafted", async () => {
    // The dialog hides the box there, but the dialog is not the guard — a stale
    // tab or a direct call would submit a body of nothing but cerber's footer.
    await saveArtifact(artifact({ status: "awaiting", summary: "", comments: [], run: null }));
    const res = await handoff({ to: "maks", postReview: true, confirm: true });
    expect(res.status).toBe(200);
    expect(submit).not.toHaveBeenCalled();
    const saved = await loadArtifact(ID);
    expect(saved?.status).toBe("skipped");
    expect(saved?.handoff?.to).toBe("maks");
  });

  it("never submits a second review on a row that already sent one", async () => {
    await saveArtifact(
      withComment({
        status: "sent",
        sent: { at: "2026-08-21T11:00:00.000Z", event: "APPROVE", url: null, auto: false },
      }),
    );
    await handoff({ to: "maks", postReview: true, confirm: true });
    expect(submit).not.toHaveBeenCalled();
    const saved = await loadArtifact(ID);
    expect(saved?.sent?.event).toBe("APPROVE");
    expect(saved?.handoff?.to).toBe("maks");
  });
});

describe("GET /api/reviews/:key/reviewers — who it could be handed to", () => {
  const get = async (key = KEY) => {
    const app = await buildApp({});
    return app.request(`/api/reviews/${key}/reviewers`);
  };

  it("offers everyone GitHub would accept, in a readable order", async () => {
    await saveArtifact(artifact());
    const res = await get();
    expect(res.status).toBe(200);
    // Sorted, and without the two GitHub would refuse: you, and the author.
    expect((await res.json()).logins).toEqual(["ada", "maks"]);
  });

  it("drops you and the author however they are spelled", async () => {
    await saveArtifact(artifact({ pr: { ...pr(), author: "SOMEONE" } }));
    login.mockResolvedValue("JACEK");
    assignable.mockResolvedValue(["Jacek", "someone", "maks"]);
    expect((await (await get()).json()).logins).toEqual(["maks"]);
  });

  it("still answers when gh cannot say who you are", async () => {
    // Not knowing costs the exclusion, not the list — and the handoff refuses
    // you by name anyway.
    await saveArtifact(artifact());
    login.mockRejectedValue(new Error("gh: not authenticated"));
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).logins).toContain("jacek");
  });

  it("reports a repo it could not read, rather than pretending it is empty", async () => {
    // Empty would read as "nobody can take this", which is a different claim.
    await saveArtifact(artifact());
    assignable.mockRejectedValue(new Error("gh: Not Found (HTTP 404)"));
    const res = await get();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("404");
  });

  it("404s on a review it has never heard of", async () => {
    expect((await get("nope__nope__1")).status).toBe(404);
    expect(assignable).not.toHaveBeenCalled();
  });
});
