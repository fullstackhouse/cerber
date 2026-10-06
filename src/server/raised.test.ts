import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Mock, beforeEach, describe, expect, it, vi } from "vitest";
import { AlreadyRaised, Artifact, Comment, SCHEMA_VERSION } from "../core/artifact.js";
import { postReplies, submitReview } from "../core/gh.js";
import { loadArtifact, saveArtifact } from "../core/state.js";
import type { ChatTurnResult } from "../runner/chat.js";
import { runChatTurn } from "../runner/chat.js";
import { checkAlreadyRaised, finishRaisedCheck, prepareRaisedCheck } from "../runner/raised.js";
import { buildApp } from "./index.js";

// Both GitHub writes Send can make are stubbed (the replies at `postReplies`,
// which is what the route calls): what posts, in what order, and
// what is recorded when half of it fails is the subject here.
vi.mock("../core/gh.js", async (orig) => ({
  ...(await orig<typeof import("../core/gh.js")>()),
  submitReview: vi.fn(),
  postReplies: vi.fn(),
}));
vi.mock("../runner/review.js", () => ({ reviewPr: vi.fn(), pool: vi.fn() }));
vi.mock("../runner/chat.js", () => ({ runChatTurn: vi.fn() }));
// The claim is real — it is in memory, and what Send waits on is the subject of
// some of these. Only the parts that would read GitHub or ask a model are stubbed.
vi.mock("../runner/raised.js", async (orig) => {
  const real = await orig<typeof import("../runner/raised.js")>();
  return {
    ...real,
    checkAlreadyRaised: vi.fn(async () => null),
    prepareRaisedCheck: vi.fn(),
    finishRaisedCheck: vi.fn(async (a: Artifact) => {
      real.releaseRaisedCheck(a.id);
      return null;
    }),
  };
});

const submit = submitReview as Mock;
const reply = postReplies as Mock;
const turn = runChatTurn as Mock;
const check = checkAlreadyRaised as Mock;
const prepare = prepareRaisedCheck as Mock;
const finish = finishRaisedCheck as Mock;

process.env.CERBER_HOME = mkdtempSync(path.join(os.tmpdir(), "cerber-raised-api-"));

const ID = "acme/widgets#42";
const KEY = "acme__widgets__42";
const DIFF = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,1 +1,2 @@", " const x = 1;", "+const y = 2;", ""].join("\n");

function raised(over: Partial<AlreadyRaised> = {}): AlreadyRaised {
  return {
    remarkId: "T_1",
    by: "someone",
    at: "2026-09-30T10:00:00Z",
    url: "https://gh/t/1",
    where: { kind: "thread", path: "a.ts", line: 2, state: "open", replyTo: "4100000001" },
    reason: "both say y is unused",
    decision: null,
    replied: null, others: [],
    ...over,
  };
}

function finding(id: string, alreadyRaised: AlreadyRaised | null): Comment {
  return {
    id,
    path: "a.ts",
    line: 2,
    body: `finding ${id}`,
    chapterId: null,
    severity: "minor",
    origin: "ai",
    status: "draft",
    editedByUser: false,
    originalLine: null,
    drifted: false,
    alreadyRaised,
  };
}

function artifact(over: Partial<Artifact> = {}): Artifact {
  const now = "2026-10-01T00:00:00Z";
  return {
    schemaVersion: SCHEMA_VERSION,
    id: ID,
    status: "ready",
    createdAt: now,
    updatedAt: now,
    pr: {
      owner: "acme",
      repo: "widgets",
      number: 42,
      title: "t",
      url: "https://github.com/acme/widgets/pull/42",
      author: "author",
      body: "",
      baseRefName: "main",
      headRefName: "f",
      headSha: "abc",
      state: "OPEN",
      isDraft: false,
      additions: 1,
      deletions: 0,
      changedFiles: 1,
    },
    diff: DIFF,
    summary: "a draft",
    chapters: [],
    comments: [],
    verdict: { recommendation: "comment", confidence: 80, reasoning: "r" },
    bodyOverride: null,
    run: null,
    sent: null,
    filed: null,
    handoff: null,
    raisedCheck: null,
    settledAt: null,
    refresh: null,
    calibration: null,
    chat: [],
    preChat: null,
    pendingChat: null,
    ...over,
  };
}

const call = async (method: string, url: string, body?: unknown) =>
  (await buildApp({})).request(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  submit.mockResolvedValue({ url: "https://gh/review/1" });
  reply.mockImplementation(async (_ref: unknown, replies: { commentId: string }[]) =>
    replies.map((r) => ({ commentId: r.commentId, at: "t", url: "https://gh/reply/1", error: null })),
  );
});

describe("deciding about a finding somebody else raised", () => {
  it("records the decision, and null puts it back to the default", async () => {
    await saveArtifact(artifact({ comments: [finding("c1", raised())] }));
    const res = await call("PATCH", `/api/reviews/${KEY}/comments/c1`, { raisedDecision: "reply" });
    expect(res.status).toBe(200);
    expect((await loadArtifact(ID))?.comments[0]?.alreadyRaised?.decision).toBe("reply");
    await call("PATCH", `/api/reviews/${KEY}/comments/c1`, { raisedDecision: null });
    expect((await loadArtifact(ID))?.comments[0]?.alreadyRaised?.decision).toBeNull();
  });

  it("refuses a decision about a comment nobody else raised", async () => {
    await saveArtifact(artifact({ comments: [finding("c1", null)] }));
    expect((await call("PATCH", `/api/reviews/${KEY}/comments/c1`, { raisedDecision: "send" })).status).toBe(409);
  });

  it("refuses to reply to a review body, which has no thread", async () => {
    await saveArtifact(artifact({ comments: [finding("c1", raised({ where: { kind: "review" } }))] }));
    const res = await call("PATCH", `/api/reviews/${KEY}/comments/c1`, { raisedDecision: "reply" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("review body");
  });

  it("refuses a decision that is not one", async () => {
    await saveArtifact(artifact({ comments: [finding("c1", raised())] }));
    expect((await call("PATCH", `/api/reviews/${KEY}/comments/c1`, { raisedDecision: "maybe" })).status).toBe(400);
  });
});

describe("Send", () => {
  it("leaves an undecided duplicate out, and replies in the thread after the review", async () => {
    await saveArtifact(
      artifact({
        comments: [
          finding("new", null),
          finding("dup", raised()),
          finding("answer", raised({ remarkId: "T_2", decision: "reply" })),
        ],
      }),
    );
    const res = await call("POST", `/api/reviews/${KEY}/send`, { event: "COMMENT", confirm: true });
    expect(res.status).toBe(200);

    const posted = submit.mock.calls[0]?.[1] as { comments: { body: string }[]; body: string };
    expect(posted.comments.map((c) => c.body)).toEqual(["⚠️ **minor** — finding new"]);
    expect(posted.body).not.toContain("finding dup");
    expect(reply).toHaveBeenCalledWith({ owner: "acme", repo: "widgets", number: 42 }, [
      { commentId: "answer", replyTo: "4100000001", body: "⚠️ **minor** — finding answer" },
    ]);
    // The review first, then the reply: a review that failed leaves nothing posted.
    expect(submit.mock.invocationCallOrder[0]).toBeLessThan(reply.mock.invocationCallOrder[0]!);

    const saved = await loadArtifact(ID);
    expect(saved?.status).toBe("sent");
    expect(saved?.comments.find((c) => c.id === "answer")?.alreadyRaised?.replied?.url).toBe("https://gh/reply/1");
  });

  it("posts no reply when the review itself failed", async () => {
    submit.mockRejectedValue(new Error("422"));
    await saveArtifact(artifact({ comments: [finding("answer", raised({ decision: "reply" }))] }));
    const res = await call("POST", `/api/reviews/${KEY}/send`, { event: "COMMENT", confirm: true });
    expect(res.status).toBe(502);
    expect(reply).not.toHaveBeenCalled();
    expect((await loadArtifact(ID))?.sent).toBeNull();
  });

  it("stays sent when a reply fails, and says which", async () => {
    reply.mockResolvedValue([{ commentId: "answer", at: "t", url: null, error: "HTTP 404: thread gone" }]);
    await saveArtifact(artifact({ comments: [finding("answer", raised({ decision: "reply" }))] }));
    const res = await call("POST", `/api/reviews/${KEY}/send`, { event: "COMMENT", confirm: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.replyError).toContain("1 reply in an existing thread did not post");
    const saved = await loadArtifact(ID);
    expect(saved?.sent).not.toBeNull();
    expect(saved?.comments[0]?.alreadyRaised?.replied).toBeNull();
  });
});

describe("POST /raised", () => {
  it("detaches only a model call, marking the check running first", async () => {
    const step = { needsModel: true, finish: vi.fn() };
    prepare.mockResolvedValue(step);
    await saveArtifact(artifact({ comments: [finding("c1", null)] }));
    const res = await call("POST", `/api/reviews/${KEY}/raised`);
    expect(res.status).toBe(202);
    expect((await res.json()).raisedCheck.checkingSince).toEqual(expect.any(String));
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ id: ID }), step);
  });

  it("holds Send off while the GitHub read is still out, and lets go after it", async () => {
    let read: (step: unknown) => void = () => {};
    prepare.mockImplementation(() => new Promise((resolve) => (read = resolve)));
    await saveArtifact(artifact({ comments: [finding("c1", null)] }));
    const opening = call("POST", `/api/reviews/${KEY}/raised`);
    await vi.waitFor(() => expect(prepare).toHaveBeenCalled());

    const refused = await call("POST", `/api/reviews/${KEY}/send`, { event: "COMMENT", confirm: true });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toContain("checking which findings");
    expect(submit).not.toHaveBeenCalled();

    // A second open while this one is out is answered, not refused.
    expect((await call("POST", `/api/reviews/${KEY}/raised`)).status).toBe(202);

    read({ needsModel: false, fold: (a: Artifact) => a });
    expect((await opening).status).toBe(200);
    expect((await call("POST", `/api/reviews/${KEY}/send`, { event: "COMMENT", confirm: true })).status).toBe(200);
  });

  it("answers at once and writes nothing when nothing changed — opening a review does not move its row", async () => {
    const same = { at: "t", checkingSince: null, remarks: ["T_1"], findings: ["c1"], error: null };
    prepare.mockResolvedValue({
      needsModel: false,
      fold: (a: Artifact) => ({ ...a, raisedCheck: { ...same, at: "later" } }),
    });
    await saveArtifact(artifact({ comments: [finding("c1", null)], raisedCheck: same }));
    const before = (await loadArtifact(ID))?.updatedAt;
    const res = await call("POST", `/api/reviews/${KEY}/raised`);
    expect(res.status).toBe(200);
    expect((await loadArtifact(ID))?.updatedAt).toBe(before);
    expect(check).not.toHaveBeenCalled();
  });

  it("writes a thread that was resolved since, without a model call", async () => {
    prepare.mockResolvedValue({
      needsModel: false,
      fold: (a: Artifact) => ({
        ...a,
        comments: a.comments.map((c) => ({
          ...c,
          alreadyRaised: raised({ where: { kind: "thread", path: "a.ts", line: 2, state: "resolved", replyTo: "1" } }),
        })),
      }),
    });
    await saveArtifact(artifact({ comments: [finding("c1", raised())] }));
    expect((await call("POST", `/api/reviews/${KEY}/raised`)).status).toBe(200);
    const saved = await loadArtifact(ID);
    expect(saved?.comments[0]?.alreadyRaised?.where).toMatchObject({ state: "resolved" });
  });

  it("leaves a sent review alone", async () => {
    await saveArtifact(
      artifact({ status: "sent", sent: { at: "t", event: "COMMENT", url: null, auto: false } }),
    );
    expect((await call("POST", `/api/reviews/${KEY}/raised`)).status).toBe(409);
    expect(check).not.toHaveBeenCalled();
  });

  it("leaves a review a run is about to replace — the run checks for itself", async () => {
    await saveArtifact(artifact({ status: "running" }));
    expect((await call("POST", `/api/reviews/${KEY}/raised`)).status).toBe(409);
    expect(check).not.toHaveBeenCalled();
  });
});

describe("a chat turn that adds a finding", () => {
  it("starts a check in the same write that lands the turn", async () => {
    const before = artifact({ comments: [finding("c1", null)] });
    await saveArtifact(before);
    const after = { ...before, comments: [...before.comments, finding("added", null)] };
    turn.mockResolvedValue({ artifact: after } as unknown as ChatTurnResult);

    expect((await call("POST", `/api/reviews/${KEY}/chat`, { message: "add one about y" })).status).toBe(202);
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    const saved = await loadArtifact(ID);
    expect(saved?.pendingChat).toBeNull();
    expect(saved?.raisedCheck?.checkingSince).toEqual(expect.any(String));
  });

  it("starts none when the turn added nothing", async () => {
    const before = artifact({ comments: [finding("c1", null)] });
    await saveArtifact(before);
    turn.mockResolvedValue({ artifact: before } as unknown as ChatTurnResult);

    await call("POST", `/api/reviews/${KEY}/chat`, { message: "why?" });
    await vi.waitFor(async () => expect((await loadArtifact(ID))?.pendingChat).toBeNull());
    expect(check).not.toHaveBeenCalled();
  });
});
