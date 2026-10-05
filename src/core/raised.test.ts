import { describe, expect, it } from "vitest";
import { AlreadyRaised, Artifact, Comment, SCHEMA_VERSION } from "./artifact.js";
import {
  PriorRemark,
  foldRaised,
  foldRaisedError,
  pickMatch,
  raisedChanged,
  raisedFrom,
  sendTreatment,
  startRaisedCheck,
  whatToCompare,
} from "./raised.js";

function comment(over: Partial<Comment> = {}): Comment {
  return {
    id: "c1",
    path: "src/balance.ts",
    line: 12,
    body: "The opening day counts the opening balance twice.",
    chapterId: null,
    severity: "blocker",
    origin: "ai",
    status: "draft",
    editedByUser: false,
    originalLine: null,
    drifted: false,
    alreadyRaised: null,
    ...over,
  };
}

function thread(over: Partial<Extract<PriorRemark, { kind: "thread" }>> = {}): PriorRemark {
  return {
    kind: "thread",
    id: "T_1",
    by: "a-bot[bot]",
    bot: true,
    at: "2026-09-30T10:00:00Z",
    body: "Balance before the opening day includes the opening entry.",
    url: "https://github.com/acme/widgets/pull/7#discussion_r1",
    path: "src/balance.ts",
    line: 14,
    state: "open",
    replyTo: "1001",
    ...over,
  };
}

function review(over: Partial<Extract<PriorRemark, { kind: "review" }>> = {}): PriorRemark {
  return {
    kind: "review",
    id: "R_1",
    by: "someone",
    bot: false,
    at: "2026-09-30T11:00:00Z",
    body: "Two things: the opening balance, and the inactive account.",
    url: "https://github.com/acme/widgets/pull/7#pullrequestreview-1",
    ...over,
  };
}

function artifact(over: Partial<Artifact> = {}): Artifact {
  const now = "2026-10-01T00:00:00Z";
  return {
    schemaVersion: SCHEMA_VERSION,
    id: "acme/widgets#7",
    status: "ready",
    createdAt: now,
    updatedAt: now,
    pr: {
      owner: "acme",
      repo: "widgets",
      number: 7,
      title: "feat: ledger",
      url: "https://github.com/acme/widgets/pull/7",
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
    diff: "",
    summary: "",
    chapters: [],
    comments: [comment()],
    verdict: null,
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

const raised = (remark: PriorRemark, over: Partial<AlreadyRaised> = {}): AlreadyRaised => ({
  ...raisedFrom(remark, "same defect"),
  ...over,
});

describe("sendTreatment", () => {
  it("posts a comment nobody else raised", () => {
    expect(sendTreatment(comment())).toBe("post");
  });

  it("holds an undecided match on an open thread, an outdated one, or a review body", () => {
    expect(sendTreatment(comment({ alreadyRaised: raised(thread()) }))).toBe("hold");
    expect(sendTreatment(comment({ alreadyRaised: raised(thread({ state: "outdated" })) }))).toBe("hold");
    expect(sendTreatment(comment({ alreadyRaised: raised(review()) }))).toBe("hold");
  });

  it("posts an undecided match on a resolved thread — the problem is still in the code", () => {
    expect(sendTreatment(comment({ alreadyRaised: raised(thread({ state: "resolved" })) }))).toBe("post");
  });

  it("follows the user's decision", () => {
    expect(sendTreatment(comment({ alreadyRaised: raised(thread(), { decision: "send" }) }))).toBe("post");
    expect(sendTreatment(comment({ alreadyRaised: raised(thread(), { decision: "reply" }) }))).toBe("reply");
  });

  it("holds a reply decision that has no thread to reply in, rather than posting it", () => {
    expect(sendTreatment(comment({ alreadyRaised: raised(review(), { decision: "reply" }) }))).toBe("hold");
  });
});

describe("pickMatch", () => {
  it("prefers the liveliest place over the earliest", () => {
    const resolved = raised(thread({ id: "T_old", state: "resolved", at: "2026-09-01T00:00:00Z" }));
    const body = raised(review({ at: "2026-09-02T00:00:00Z" }));
    const open = raised(thread({ id: "T_new", at: "2026-09-03T00:00:00Z" }));
    expect(pickMatch([resolved, body, open])?.remarkId).toBe("T_new");
    expect(pickMatch([resolved, body])?.remarkId).toBe("R_1");
  });

  it("breaks a tie by who said it first", () => {
    const later = raised(thread({ id: "T_b", at: "2026-09-03T00:00:00Z" }));
    const first = raised(thread({ id: "T_a", at: "2026-09-01T00:00:00Z" }));
    expect(pickMatch([later, first])?.remarkId).toBe("T_a");
  });

  it("is null for nothing", () => {
    expect(pickMatch([])).toBeNull();
  });
});

describe("whatToCompare", () => {
  it("compares everything the first time", () => {
    const plan = whatToCompare([comment()], [thread()], null);
    expect(plan.findings.map((f) => f.id)).toEqual(["c1"]);
    expect(plan.remarks.map((r) => r.id)).toEqual(["T_1"]);
  });

  it("asks nothing when nothing is new — opening a review costs no model call", () => {
    const previous = { at: "x", checkingSince: null, remarks: ["T_1"], findings: ["c1"], error: null };
    expect(whatToCompare([comment()], [thread()], previous)).toEqual({ findings: [], remarks: [] });
  });

  it("compares a new remark against every finding", () => {
    const previous = { at: "x", checkingSince: null, remarks: ["T_1"], findings: ["c1", "c2"], error: null };
    const plan = whatToCompare([comment(), comment({ id: "c2" })], [thread(), review()], previous);
    expect(plan.findings.map((f) => f.id)).toEqual(["c1", "c2"]);
    expect(plan.remarks.map((r) => r.id)).toEqual(["R_1"]);
  });

  it("compares a finding a chat turn added against every remark", () => {
    const previous = { at: "x", checkingSince: null, remarks: ["T_1", "R_1"], findings: ["c1"], error: null };
    const plan = whatToCompare([comment(), comment({ id: "c2" })], [thread(), review()], previous);
    expect(plan.findings.map((f) => f.id)).toEqual(["c2"]);
    expect(plan.remarks.map((r) => r.id)).toEqual(["T_1", "R_1"]);
  });

  it("leaves out dropped comments and the user's own", () => {
    const plan = whatToCompare(
      [comment({ status: "dropped" }), comment({ id: "mine", origin: "user" })],
      [thread()],
      null,
    );
    expect(plan.findings).toEqual([]);
  });
});

describe("foldRaised", () => {
  const at = "2026-10-02T00:00:00Z";

  it("writes the match onto the comment and records what was compared", () => {
    const folded = foldRaised(artifact(), {
      at,
      remarks: [thread()],
      findings: ["c1"],
      matches: [{ findingId: "c1", remarkId: "T_1", reason: "both say the opening day double-counts" }],
    });
    expect(folded.comments[0]?.alreadyRaised).toMatchObject({
      remarkId: "T_1",
      by: "a-bot[bot]",
      reason: "both say the opening day double-counts",
      where: { kind: "thread", state: "open", replyTo: "1001" },
      decision: null,
    });
    expect(folded.raisedCheck).toEqual({ at, checkingSince: null, remarks: ["T_1"], findings: ["c1"], error: null });
  });

  it("keeps the user's decision while it is about the same remark, and refreshes the thread's state", () => {
    const before = artifact({
      comments: [comment({ alreadyRaised: raised(thread(), { decision: "reply" }) })],
    });
    const folded = foldRaised(before, {
      at,
      remarks: [thread({ state: "resolved" })],
      findings: ["c1"],
      matches: [],
    });
    expect(folded.comments[0]?.alreadyRaised).toMatchObject({
      decision: "reply",
      where: { kind: "thread", state: "resolved" },
    });
  });

  it("drops a match whose remark is gone from the PR", () => {
    const before = artifact({ comments: [comment({ alreadyRaised: raised(thread()) })] });
    const folded = foldRaised(before, { at, remarks: [], findings: ["c1"], matches: [] });
    expect(folded.comments[0]?.alreadyRaised).toBeNull();
  });

  it("moves to a livelier place when one turns up, and the decision does not follow it", () => {
    const before = artifact({
      comments: [comment({ alreadyRaised: raised(thread({ state: "resolved" }), { decision: "send" }) })],
    });
    const fresh = thread({ id: "T_2", state: "open", replyTo: "2002" });
    const folded = foldRaised(before, {
      at,
      remarks: [thread({ state: "resolved" }), fresh],
      findings: ["c1"],
      matches: [{ findingId: "c1", remarkId: "T_2", reason: "raised again, still open" }],
    });
    expect(folded.comments[0]?.alreadyRaised).toMatchObject({ remarkId: "T_2", decision: null });
  });

  it("ignores matches for comments that are no longer there", () => {
    const folded = foldRaised(artifact(), {
      at,
      remarks: [thread()],
      findings: ["gone"],
      matches: [{ findingId: "gone", remarkId: "T_1", reason: "x" }],
    });
    expect(folded.comments[0]?.alreadyRaised).toBeNull();
  });

  it("re-decides nothing on a sent review", () => {
    const sent = artifact({
      status: "sent",
      sent: { at, event: "COMMENT", url: null, auto: false },
      raisedCheck: { at: null, checkingSince: at, remarks: [], findings: [], error: null },
    });
    const folded = foldRaised(sent, {
      at,
      remarks: [thread()],
      findings: ["c1"],
      matches: [{ findingId: "c1", remarkId: "T_1", reason: "x" }],
    });
    expect(folded.comments[0]?.alreadyRaised).toBeNull();
    expect(folded.raisedCheck?.checkingSince).toBeNull();
  });
});

describe("startRaisedCheck / foldRaisedError", () => {
  it("marks a check running, and a failure clears the mark and keeps the matches", () => {
    const withMatch = artifact({ comments: [comment({ alreadyRaised: raised(thread()) })] });
    const started = startRaisedCheck(withMatch, "2026-10-02T00:00:00Z");
    expect(started.raisedCheck?.checkingSince).toBe("2026-10-02T00:00:00Z");
    const failed = foldRaisedError(started, "2026-10-02T00:00:05Z", "gh: rate limited");
    expect(failed.raisedCheck).toMatchObject({ checkingSince: null, error: "gh: rate limited" });
    expect(failed.comments[0]?.alreadyRaised?.remarkId).toBe("T_1");
  });
});

describe("raisedChanged", () => {
  it("ignores a check that only moved its own clock", () => {
    const check = { at: "t1", checkingSince: null, remarks: ["T_1"], findings: ["c1"], error: null };
    const a = artifact({ raisedCheck: check });
    expect(raisedChanged(a, { ...a, raisedCheck: { ...check, at: "t2" } })).toBe(false);
  });

  it("sees a new match, a state change, a new remark and a cleared mark", () => {
    const check = { at: "t1", checkingSince: null, remarks: ["T_1"], findings: ["c1"], error: null };
    const a = artifact({ raisedCheck: check, comments: [comment({ alreadyRaised: raised(thread()) })] });
    expect(raisedChanged(a, { ...a, comments: [comment()] })).toBe(true);
    expect(
      raisedChanged(a, { ...a, comments: [comment({ alreadyRaised: raised(thread({ state: "resolved" })) })] }),
    ).toBe(true);
    expect(raisedChanged(a, { ...a, raisedCheck: { ...check, remarks: ["T_1", "R_1"] } })).toBe(true);
    expect(raisedChanged({ ...a, raisedCheck: { ...check, checkingSince: "t" } }, a)).toBe(true);
  });
});
