import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Mock, beforeEach, describe, expect, it, vi } from "vitest";
import { Artifact, ArtifactStatus, PrInfo, SCHEMA_VERSION } from "../core/artifact.js";
import { submitReview } from "../core/gh.js";
import { loadArtifact, saveArtifact } from "../core/state.js";
import { beginReview, endReview } from "../runner/inflight.js";
import { buildApp } from "./index.js";

// The only GitHub write in the product. Stubbed so a test can assert it was
// *not* called, which is the whole subject of half this file.
vi.mock("../core/gh.js", async (orig) => ({
  ...(await orig<typeof import("../core/gh.js")>()),
  submitReview: vi.fn(),
}));
vi.mock("../runner/review.js", () => ({ reviewPr: vi.fn(), pool: vi.fn() }));

const submit = submitReview as Mock;

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
    run: null,
    sent: null,
    filed: null,
    settledAt: null,
    refresh: null,
    calibration: null,
    chat: [],
    preChat: null,
    pendingChat: null,
  };
}

const send = async () => {
  const app = await buildApp({});
  return app.request(`/api/reviews/${KEY}/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event: "APPROVE", confirm: true }),
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

beforeEach(() => {
  vi.clearAllMocks();
  submit.mockResolvedValue({ url: "https://github.com/acme/widgets/pull/42#r1" });
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

  it("refuses a second submission of one already sent", async () => {
    await saveArtifact(artifact("ready"));
    expect((await send()).status).toBe(200);

    const again = await send();
    expect(again.status).toBe(409);
    expect(submit).toHaveBeenCalledOnce();
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
});
