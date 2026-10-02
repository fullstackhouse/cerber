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
} from "../core/gh.js";
import { loadArtifact, saveArtifact } from "../core/state.js";
import { buildApp } from "./index.js";

// The handoff's two writes, and the login it needs to know who to take off.
// Stubbed so the tests can assert on what was *not* called, which is most of
// what there is to get wrong here.
vi.mock("../core/gh.js", async (orig) => ({
  ...(await orig<typeof import("../core/gh.js")>()),
  handOffReview: vi.fn(),
  postIssueComment: vi.fn(),
  fetchAssignableUsers: vi.fn(),
  currentLogin: vi.fn(),
  fetchPrInfo: vi.fn(),
  fetchPrDiff: vi.fn(),
}));
vi.mock("../runner/review.js", () => ({ reviewPr: vi.fn(), pool: vi.fn() }));

const swap = handOffReview as Mock;
const comment = postIssueComment as Mock;
const login = currentLogin as Mock;
const assignable = fetchAssignableUsers as Mock;

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
