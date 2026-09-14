import { Mock, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact } from "./artifact.js";
import {
  Arrival,
  NOTIFY_TIMEOUT_MS,
  appleScriptLiteral,
  isNews,
  newsOf,
  notice,
  notify,
  notifyCommand,
} from "./notify.js";

// Callback-shaped on purpose: notify.ts promisifies execFile at import, so the
// mock has to be the thing promisify can wrap.
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
const { execFile } = await import("node:child_process");
const execFileMock = execFile as unknown as Mock;

beforeEach(() => {
  execFileMock.mockReset();
});

const pr = (number: number, over: Partial<Arrival> = {}): Arrival => ({
  repo: "widgets",
  number,
  title: "feat: add sprockets",
  author: "mira",
  ...over,
});

describe("what one poll's arrivals say", () => {
  it("says nothing when nothing arrived", () => {
    expect(notice([])).toBeNull();
  });

  it("names the one PR that landed, and who wrote it", () => {
    expect(notice([pr(7)])).toEqual({
      title: "widgets#7 awaits your review",
      body: "feat: add sprockets — mira",
    });
  });

  it("folds a batch into one popup rather than five", () => {
    expect(notice([pr(1), pr(2), pr(3)])).toEqual({
      title: "3 PRs await your review",
      body: "widgets#1, widgets#2, widgets#3",
    });
  });

  it("counts the ones it has no room to name", () => {
    expect(notice([pr(1), pr(2), pr(3), pr(4), pr(5)])?.body).toBe(
      "widgets#1, widgets#2, widgets#3 and 2 more",
    );
  });
});

describe("what a finished draft says", () => {
  const ready = (over: Partial<Arrival["draft"] & object> = {}): Arrival => ({
    ...pr(7),
    draft: { recommendation: "request_changes", blockers: 2, ...over },
  });

  it("leads with the verdict and the count it rests on", () => {
    expect(notice([ready()])).toEqual({
      title: "widgets#7 draft ready",
      body: "requests changes · 2 blockers — feat: add sprockets",
    });
  });

  it("counts one blocker as one", () => {
    expect(notice([ready({ blockers: 1 })])?.body).toBe(
      "requests changes · 1 blocker — feat: add sprockets",
    );
  });

  it("has no count to give when nothing blocks", () => {
    expect(notice([ready({ recommendation: "approve", blockers: 0 })])?.body).toBe(
      "approves — feat: add sprockets",
    );
  });

  it("still says something about a draft that took no position", () => {
    expect(notice([ready({ recommendation: null, blockers: 0 })])?.body).toBe(
      "drafted — feat: add sprockets",
    );
  });

  it("calls a batch of drafts what it is", () => {
    expect(notice([ready(), { ...pr(8), draft: { recommendation: "approve", blockers: 0 } }])?.title).toBe(
      "2 drafts ready",
    );
  });

  // A drafted PR awaits you too, so the wording true of both is the one used.
  it("falls back to the general headline when only some are drafted", () => {
    expect(notice([ready(), pr(8)])?.title).toBe("2 PRs await your review");
  });
});

describe("whether a row is news yet", () => {
  const artifact = (over: Partial<Artifact> = {}): Artifact =>
    ({
      status: "awaiting",
      pr: { repo: "widgets", number: 7, title: "feat: add sprockets", author: "mira", state: "OPEN" },
      comments: [],
      verdict: null,
      ...over,
    }) as Artifact;

  // The whole point: with cerber drafting, a tap on arrival lands on "no run
  // yet" — and the moment there is something to read would pass in silence.
  it("holds back a PR cerber is about to draft, or is drafting", () => {
    expect(isNews(artifact({ status: "awaiting" }), true)).toBe(false);
    expect(isNews(artifact({ status: "running" }), true)).toBe(false);
  });

  it("announces the arrival when nobody is going to draft it", () => {
    expect(isNews(artifact({ status: "awaiting" }), false)).toBe(true);
  });

  it("announces the draft the moment it exists", () => {
    expect(isNews(artifact({ status: "ready" }), true)).toBe(true);
  });

  // Nothing more is coming for it, so this is the only tap there will be.
  it("announces a run that failed", () => {
    expect(isNews(artifact({ status: "failed" }), true)).toBe(true);
  });

  it("says nothing about a row you already answered, or a PR that is gone", () => {
    expect(isNews(artifact({ status: "reviewed" }), true)).toBe(false);
    expect(isNews(artifact({ status: "skipped" }), true)).toBe(false);
    expect(isNews(artifact({ status: "sent" }), true)).toBe(false);
    expect(isNews(artifact({ status: "ready", pr: { ...artifact().pr, state: "MERGED" } }), true)).toBe(
      false,
    );
  });

  it("reads the draft off the artifact, blockers and all", () => {
    const a = artifact({
      status: "ready",
      verdict: { recommendation: "request_changes", confidence: 70, reasoning: "" },
      comments: [
        { severity: "blocker", status: "draft" },
        { severity: "blocker", status: "dropped" },
        { severity: "nit", status: "draft" },
      ],
    } as Partial<Artifact>);
    expect(newsOf(a).draft).toEqual({ recommendation: "request_changes", blockers: 1 });
  });

  it("carries no draft for a row that has none", () => {
    expect(newsOf(artifact({ status: "awaiting" })).draft).toBeNull();
    expect(newsOf(artifact({ status: "failed" })).draft).toBeNull();
  });
});

describe("a PR title inside an AppleScript literal", () => {
  it("quotes ordinary text", () => {
    expect(appleScriptLiteral("feat: add sprockets")).toBe('"feat: add sprockets"');
  });

  // The title is somebody else's text and osascript takes a script, not
  // arguments: an unescaped quote would end the string and run what follows.
  it("cannot be closed early by a quote in the title", () => {
    expect(appleScriptLiteral('fix the "wobble"')).toBe('"fix the \\"wobble\\""');
  });

  it("escapes a backslash before it can escape our quote", () => {
    expect(appleScriptLiteral('a\\"b')).toBe('"a\\\\\\"b"');
  });

  it("gives a script-shaped title nothing to run with", () => {
    expect(appleScriptLiteral('" & (do shell script "touch /tmp/pwned") & "')).toBe(
      '"\\" & (do shell script \\"touch /tmp/pwned\\") & \\""',
    );
  });

  it("flattens the newlines a literal cannot hold", () => {
    expect(appleScriptLiteral("first line\nsecond\tline")).toBe('"first line second line"');
  });
});

describe("the command that taps the machine", () => {
  const n = { title: "widgets#7 awaits your review", body: "feat: add sprockets — mira" };

  it("hands macOS one display-notification script", () => {
    const cmd = notifyCommand(n, "darwin");
    expect(cmd?.file).toBe("osascript");
    expect(cmd?.args[1]).toBe(
      'display notification "feat: add sprockets — mira" with title "widgets#7 awaits your review"',
    );
  });

  it("hands Linux the title and body as arguments, never a shell", () => {
    expect(notifyCommand(n, "linux")).toEqual({
      file: "notify-send",
      args: ["--app-name=cerber", "--", n.title, n.body],
    });
  });

  // The PR's title arrives here inside the body — `notice()` writes the summary
  // itself — so the body is the argument that carries somebody else's text.
  it("ends Linux option parsing, so a body starting with a dash is still text", () => {
    const dashed = { title: "widgets#7 awaits your review", body: "--help me — mira" };
    const cmd = notifyCommand(dashed, "linux");
    // The marker sits before both, so neither can be read as a flag.
    expect(cmd?.args.indexOf("--")).toBeLessThan(cmd!.args.indexOf(dashed.body));
    expect(cmd?.args).toEqual(["--app-name=cerber", "--", dashed.title, dashed.body]);
  });

  it("stays quiet on a platform with nothing to tap", () => {
    expect(notifyCommand(n, "win32")).toBeNull();
  });
});

// The daemon awaits this call and won't start a poll while one is running, so
// "the notifier failed" and "the notifier never answered" have to end the same
// way. A wedged Notification Centre must cost one notification, not discovery.
describe("a notifier that misbehaves", () => {
  it("gives the notifier a deadline rather than waiting forever", async () => {
    execFileMock.mockImplementation((_file, _args, _opts, cb) => cb(null, "", ""));
    await notify({ title: "widgets#7 awaits your review", body: "feat: add sprockets — mira" });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0]![2]).toMatchObject({ timeout: NOTIFY_TIMEOUT_MS });
    expect(NOTIFY_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  it("answers false when it is killed on that deadline, rather than throwing", async () => {
    // What execFile hands back on a timeout: the child is signalled and the
    // call rejects, which must read as an ordinary "not shown".
    const killed = Object.assign(new Error("spawn ETIMEDOUT"), { killed: true, signal: "SIGTERM" });
    execFileMock.mockImplementation((_file, _args, _opts, cb) => cb(killed, "", ""));
    await expect(
      notify({ title: "widgets#7 awaits your review", body: "feat: add sprockets — mira" }),
    ).resolves.toBe(false);
  });
});
