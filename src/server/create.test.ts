import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Mock, beforeEach, describe, expect, it, vi } from "vitest";
import { Artifact, SCHEMA_VERSION, PrInfo } from "../core/artifact.js";
import { fetchPrInfo } from "../core/gh.js";
import { beginReview, endReview } from "../runner/inflight.js";
import { saveArtifact } from "../core/state.js";
import { reviewPr } from "../runner/review.js";
import { isPureStub, stubArtifact } from "./daemon.js";
import { buildApp } from "./index.js";

// The review itself shells out to `claude` for minutes, and fetchPrInfo shells
// out to `gh`. What these tests are about is the handler in front of both.
vi.mock("../runner/review.js", () => ({ reviewPr: vi.fn(), pool: vi.fn() }));
vi.mock("../core/gh.js", async (orig) => ({
  ...(await orig<typeof import("../core/gh.js")>()),
  fetchPrInfo: vi.fn(),
}));

const run = reviewPr as Mock;
const prInfo = fetchPrInfo as Mock;

const home = mkdtempSync(path.join(os.tmpdir(), "cerber-create-api-"));
process.env.CERBER_HOME = home;

const URL = "https://github.com/acme/widgets/pull/42";

function pr(over: Partial<PrInfo> = {}): PrInfo {
  return {
    owner: "acme",
    repo: "widgets",
    number: 42,
    title: "Add a thing",
    url: URL,
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
    ...over,
  };
}

const post = async (input: unknown) => {
  const app = await buildApp({});
  return app.request("/api/reviews", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
};

beforeEach(async () => {
  vi.clearAllMocks();
  // A never-settling run: the endpoint must answer without it, which is the
  // whole point of the detached shape.
  run.mockReturnValue(new Promise(() => {}));
  prInfo.mockResolvedValue(pr());
  const { promises: fs } = await import("node:fs");
  await fs.rm(path.join(home, "reviews"), { recursive: true, force: true });
});

describe("POST /api/reviews — pulling a PR in from the cockpit", () => {
  it("accepts a PR URL and starts the review", async () => {
    const res = await post({ input: URL });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Artifact & { key: string };
    expect(body.id).toBe("acme/widgets#42");
    // The cockpit navigates by key, so the server hands it over rather than
    // making the browser re-derive the filename format.
    expect(body.key).toBe("acme__widgets__42");
    expect(run).toHaveBeenCalledWith(
      { owner: "acme", repo: "widgets", number: 42 },
      expect.objectContaining({ force: true }),
    );
  });

  it("accepts the owner/repo#number short form", async () => {
    const res = await post({ input: "acme/widgets#42" });
    expect(res.status).toBe(202);
    expect(run).toHaveBeenCalledOnce();
  });

  // The regression this endpoint exists to avoid. reviewPr spends minutes on
  // the diff, trust and checkout before it writes anything, and a PR pulled in
  // this way is by definition absent from the awaiting search — so an artifact
  // left looking like a fresh stub is one the daemon's reaper would delete
  // out from under a running review.
  it("persists a running artifact the reaper cannot mistake for a stub", async () => {
    const res = await post({ input: URL });
    const body = (await res.json()) as Artifact;

    expect(body.status).toBe("running");
    expect(body.run).not.toBeNull();
    expect(isPureStub(body)).toBe(false);

    // And it is on disk before the response, not only in the response.
    const app = await buildApp({});
    const saved = await app.request("/api/reviews/acme__widgets__42");
    expect(saved.status).toBe(200);
    expect(isPureStub((await saved.json()) as Artifact)).toBe(false);
  });

  it("hands back a PR already in the queue instead of reviewing it twice", async () => {
    const first = await post({ input: URL });
    expect(first.status).toBe(202);
    expect(run).toHaveBeenCalledOnce();

    const second = await post({ input: URL });
    expect(second.status).toBe(200);
    expect(((await second.json()) as Artifact).id).toBe("acme/widgets#42");
    // Still once: the second paste opened the existing review, it did not
    // start a competing run against the same artifact file.
    expect(run).toHaveBeenCalledOnce();
  });

  // The queue can already hold a PR without holding a review of it: with
  // auto-review off, discovery leaves bare `awaiting` stubs. Pasting such a PR
  // is the user asking for the review that does not exist yet, so handing the
  // stub back would answer 200 while quietly dropping the actual request.
  it("starts the review when the queue holds only an un-reviewed stub", async () => {
    await saveArtifact(
      stubArtifact({
        owner: "acme",
        repo: "widgets",
        number: 42,
        title: "Add a thing",
        url: URL,
        updatedAt: "2026-08-20T00:00:00Z",
        isDraft: false,
        author: "someone",
      }),
    );

    const res = await post({ input: URL });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Artifact;
    expect(body.status).toBe("running");
    expect(isPureStub(body)).toBe(false);
    expect(run).toHaveBeenCalledOnce();
  });

  it("refuses to start a second run while one is already in flight", async () => {
    beginReview("acme/widgets#42");
    try {
      const res = await post({ input: URL });
      expect(res.status).toBe(409);
      expect(run).not.toHaveBeenCalled();
    } finally {
      endReview("acme/widgets#42");
    }
  });

  it("reports a reference it cannot parse without starting anything", async () => {
    const res = await post({ input: "not a pull request" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/cannot parse/i);
    expect(run).not.toHaveBeenCalled();
  });

  it("explains that a bare number does not say which repo", async () => {
    const res = await post({ input: "42" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/which repo/i);
    expect(run).not.toHaveBeenCalled();
  });

  // The run is detached, so this is the only moment a bad paste can be
  // reported at all — after the 202 there is no response left to fail into.
  it("surfaces a GitHub failure as 502 rather than a silent dead artifact", async () => {
    prInfo.mockRejectedValue(new Error("gh pr view failed: could not resolve to a PullRequest"));
    const res = await post({ input: URL });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/could not resolve/);
    expect(run).not.toHaveBeenCalled();

    const app = await buildApp({});
    expect((await app.request("/api/reviews/acme__widgets__42")).status).toBe(404);
  });

  it("rejects a request with no input at all", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it("carries the draft flag onto a pulled-in draft PR", async () => {
    prInfo.mockResolvedValue(pr({ isDraft: true }));
    const res = await post({ input: URL });
    expect(((await res.json()) as Artifact).pr.isDraft).toBe(true);
  });
});
