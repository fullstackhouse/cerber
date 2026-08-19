import { promises as fs } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Mock, beforeEach, describe, expect, it, vi } from "vitest";
import { Artifact, SCHEMA_VERSION } from "../core/artifact.js";
// Type-only: the mock below replaces this module with `runChatTurn` alone, so
// a value import of the type would ask for an export that isn't there.
import type { ChatTurnResult } from "../runner/chat.js";
import { runChatTurn } from "../runner/chat.js";
import { buildApp } from "./index.js";

// The turn itself shells out to `claude` for minutes — what these tests are
// about is the handler that no longer waits for it.
vi.mock("../runner/chat.js", () => ({ runChatTurn: vi.fn() }));
const turn = runChatTurn as Mock;

const home = mkdtempSync(path.join(os.tmpdir(), "cerber-chat-api-"));
process.env.CERBER_HOME = home;

const KEY = "acme__widgets__42";

function artifact(over: Partial<Artifact> = {}): Artifact {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: "acme/widgets#42",
    status: "ready",
    createdAt: "2026-08-19T00:00:00Z",
    updatedAt: "2026-08-19T00:00:00Z",
    pr: {
      owner: "acme",
      repo: "widgets",
      number: 42,
      title: "Add a thing",
      url: "u",
      author: "someone",
      body: "",
      baseRefName: "main",
      headRefName: "f",
      headSha: "abc",
      state: "OPEN",
      additions: 1,
      deletions: 0,
      changedFiles: 1,
    },
    diff: "diff",
    summary: "Argued into this.",
    chapters: [],
    comments: [],
    verdict: { recommendation: "comment", confidence: 70, reasoning: "r" },
    run: null,
    sent: null,
    refresh: null,
    calibration: null,
    chat: [],
    preChat: null,
    pendingChat: null,
    ...over,
  };
}

async function write(a: Artifact) {
  const dir = path.join(home, "reviews");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${KEY}.json`), JSON.stringify(a));
}

const post = async (url: string, body: unknown) =>
  (await buildApp({})).request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const del = async (url: string) => (await buildApp({})).request(url, { method: "DELETE" });

/** What the cockpit's poll would see. */
const read = async (): Promise<Artifact> =>
  JSON.parse(await fs.readFile(path.join(home, "reviews", `${KEY}.json`), "utf8"));

/** A turn the test resolves or rejects by hand, the way a real one takes minutes. */
function deferred() {
  let settle!: (r: ChatTurnResult) => void;
  let fail!: (e: Error) => void;
  const promise = new Promise<ChatTurnResult>((res, rej) => {
    settle = res;
    fail = rej;
  });
  turn.mockReturnValue(promise);
  return { settle, fail };
}

/** Wait for the detached turn's write to land. */
async function until(predicate: (a: Artifact) => boolean, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (predicate(await read())) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`artifact never reached the expected state: ${JSON.stringify(await read())}`);
}

beforeEach(async () => {
  await fs.rm(path.join(home, "reviews"), { recursive: true, force: true });
  turn.mockReset();
});

describe("POST /api/reviews/:key/chat", () => {
  it("404s for a review that does not exist", async () => {
    const res = await post(`/api/reviews/nope__nope__1/chat`, { message: "hi" });
    expect(res.status).toBe(404);
  });

  it("refuses to argue with a review that was already sent", async () => {
    // The sent artifact is the record of what GitHub already has; revising it
    // now would make it a description of something that never happened.
    await write(
      artifact({ sent: { at: "2026-08-19T03:00:00Z", event: "COMMENT", url: null, auto: false } }),
    );
    const res = await post(`/api/reviews/${KEY}/chat`, { message: "hi" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already sent/);
  });

  it("rejects an empty message rather than running a turn about nothing", async () => {
    await write(artifact());
    const res = await post(`/api/reviews/${KEY}/chat`, { message: "" });
    expect(res.status).toBe(400);
  });

  it("rejects a ref pointing at something that is not part of a review", async () => {
    await write(artifact());
    const res = await post(`/api/reviews/${KEY}/chat`, {
      message: "hi",
      refs: [{ target: "the-diff", id: null }],
    });
    expect(res.status).toBe(400);
  });

  it("answers 202 without waiting for the turn, and records the question", async () => {
    // A turn takes minutes. Holding the request open outlives a reverse proxy's
    // read timeout, so the browser is told it broke while the turn succeeds.
    await write(artifact());
    deferred();

    const res = await post(`/api/reviews/${KEY}/chat`, {
      message: "the summary restates the author",
      refs: [{ target: "summary", id: null }],
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.pendingChat.message).toBe("the summary restates the author");
    expect(body.pendingChat.refs).toEqual([{ target: "summary", id: null }]);
    expect(body.pendingChat.error).toBeNull();
    // On disk too: a reload mid-turn finds the question still being answered.
    expect((await read()).pendingChat?.message).toBe("the summary restates the author");
  });

  it("lands the answer on the artifact for the next poll to find", async () => {
    await write(artifact());
    const { settle } = deferred();
    await post(`/api/reviews/${KEY}/chat`, { message: "why?" });

    settle({
      artifact: artifact({
        summary: "What I actually verified.",
        chat: [
          { id: "u1", role: "user", at: "t1", body: "why?", refs: [], revisions: [], refused: [], costUsd: null },
          { id: "a1", role: "assistant", at: "t2", body: "because", refs: [], revisions: [], refused: [], costUsd: null },
        ],
      }),
      applied: [],
      refused: [],
    });

    await until((a) => a.pendingChat === null);
    const landed = await read();
    expect(landed.chat.map((t) => t.body)).toEqual(["why?", "because"]);
    expect(landed.summary).toBe("What I actually verified.");
  });

  it("records a failure against the question instead of losing it", async () => {
    // Nobody is holding a response to hand the error to any more.
    await write(artifact());
    const { fail } = deferred();
    await post(`/api/reviews/${KEY}/chat`, { message: "why?" });

    fail(new Error("claude exited 1"));

    await until((a) => a.pendingChat?.error != null);
    const failed = await read();
    expect(failed.pendingChat?.message).toBe("why?");
    expect(failed.pendingChat?.error).toMatch(/claude exited 1/);
    expect(failed.chat).toHaveLength(0);
  });

  it("puts what the turn is doing on the artifact while it does it", async () => {
    // The whole point of the detached turn: minutes of silence become minutes
    // of "reading src/core/refresh.ts".
    await write(artifact());
    let resolve!: (r: ChatTurnResult) => void;
    turn.mockImplementation((_a: Artifact, _m: string, opts: { onProgress?: (s: string) => void }) => {
      opts.onProgress?.("reading src/core/refresh.ts");
      opts.onProgress?.("searching for carryOverComments");
      return new Promise<ChatTurnResult>((r) => (resolve = r));
    });

    await post(`/api/reviews/${KEY}/chat`, { message: "did you check refresh?" });

    await until((a) => (a.pendingChat?.progress.length ?? 0) >= 2, 600);
    expect((await read()).pendingChat?.progress).toEqual([
      "reading src/core/refresh.ts",
      "searching for carryOverComments",
    ]);

    // And it goes away with the question it was describing.
    resolve({ artifact: artifact(), applied: [], refused: [] });
    await until((a) => a.pendingChat === null);
  });

  it("refuses a second turn while one is still being answered", async () => {
    await write(artifact());
    deferred();
    expect((await post(`/api/reviews/${KEY}/chat`, { message: "first" })).status).toBe(202);

    const second = await post(`/api/reviews/${KEY}/chat`, { message: "second" });
    expect(second.status).toBe(409);
    // Only one turn was ever started.
    expect(turn).toHaveBeenCalledTimes(1);
    expect((await read()).pendingChat?.message).toBe("first");
  });

  it("lets the user ask again once a turn has failed", async () => {
    await write(artifact({ pendingChat: { message: "why?", refs: [], startedAt: "t", progress: [], error: "boom" } }));
    deferred();
    const res = await post(`/api/reviews/${KEY}/chat`, { message: "why?" });
    expect(res.status).toBe(202);
    expect((await res.json()).pendingChat.error).toBeNull();
  });
});

describe("DELETE /api/reviews/:key/chat/pending", () => {
  it("clears a turn that failed", async () => {
    await write(artifact({ pendingChat: { message: "why?", refs: [], startedAt: "t", progress: [], error: "boom" } }));
    const res = await del(`/api/reviews/${KEY}/chat/pending`);
    expect(res.status).toBe(200);
    expect((await res.json()).pendingChat).toBeNull();
  });

  it("refuses one still being answered — it would come back on the next write", async () => {
    await write(artifact({ pendingChat: { message: "why?", refs: [], startedAt: "t", progress: [], error: null } }));
    const res = await del(`/api/reviews/${KEY}/chat/pending`);
    expect(res.status).toBe(409);
    expect((await read()).pendingChat?.message).toBe("why?");
  });
});

describe("POST /api/reviews/:key/chat/reset", () => {
  it("puts the review back the way it was, keeping the conversation", async () => {
    await write(
      artifact({
        summary: "Argued into this.",
        chat: [
          { id: "t1", role: "user", at: "x", body: "wrong", refs: [], revisions: [], refused: [], costUsd: null },
        ],
        preChat: {
          at: "2026-08-19T01:00:00Z",
          summary: "What the AI first wrote.",
          chapters: [],
          comments: [],
          verdict: { recommendation: "approve", confidence: 90, reasoning: "first" },
        },
      }),
    );
    const res = await post(`/api/reviews/${KEY}/chat/reset`, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toBe("What the AI first wrote.");
    expect(body.verdict.recommendation).toBe("approve");
    // You lose the edits, not the reasoning that produced them.
    expect(body.chat).toHaveLength(1);
  });

  it("refuses while a turn is still being answered", async () => {
    // The turn folds its result onto whatever is on disk when it lands, so a
    // reset now would be quietly undone a minute later.
    await write(
      artifact({
        preChat: { at: "x", summary: "first", chapters: [], comments: [], verdict: null },
        pendingChat: { message: "why?", refs: [], startedAt: "t", progress: [], error: null },
      }),
    );
    const res = await post(`/api/reviews/${KEY}/chat/reset`, {});
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/still being answered/);
  });

  it("409s when there is nothing to reset to", async () => {
    await write(artifact());
    const res = await post(`/api/reviews/${KEY}/chat/reset`, {});
    expect(res.status).toBe(409);
  });

  it("refuses to reset a review that was already sent", async () => {
    await write(
      artifact({
        sent: { at: "2026-08-19T03:00:00Z", event: "COMMENT", url: null, auto: false },
        preChat: {
          at: "x",
          summary: "first",
          chapters: [],
          comments: [],
          verdict: null,
        },
      }),
    );
    expect((await post(`/api/reviews/${KEY}/chat/reset`, {})).status).toBe(409);
  });
});
