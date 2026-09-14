import { Mock, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Artifact } from "./artifact.js";
import {
  Arrival,
  BUNDLE_ID,
  NOTIFY_TIMEOUT_MS,
  appleScriptLiteral,
  appletSource,
  clickTarget,
  ensureNotifierApp,
  isNews,
  newsOf,
  notice,
  notify,
  notifyCommand,
  pendingNews,
  pendingPayload,
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
  owner: "acme",
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
      url: null,
    });
  });

  it("folds a batch into one popup rather than five", () => {
    expect(notice([pr(1), pr(2), pr(3)])).toEqual({
      title: "3 PRs await your review",
      body: "widgets#1, widgets#2, widgets#3",
      url: null,
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
      url: null,
    });
  });

  // The click target is the same either way: which news it is changes what the
  // popup says, not where it sends you.
  it("still opens the review it is about", () => {
    expect(notice([ready()], "http://127.0.0.1:7777")?.url).toBe(
      "http://127.0.0.1:7777#/r/acme__widgets__7",
    );
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

describe("what a row still has to say, given what it has said already", () => {
  const artifact = (over: Partial<Artifact> = {}): Artifact =>
    ({
      status: "failed",
      pr: { repo: "widgets", number: 7, title: "feat: add sprockets", author: "mira", state: "OPEN" },
      comments: [],
      verdict: null,
      notified: null,
      ...over,
    }) as Artifact;

  it("says nothing about a row nobody meant to announce", () => {
    expect(pendingNews(artifact({ notified: undefined }), true)).toBeNull();
  });

  it("owes a tap on a row it has never told you about", () => {
    expect(pendingNews(artifact(), true)?.draft).toBeNull();
  });

  // The hole this shape of ledger exists to close: a failed run is retried on
  // the next poll, and a ledger that only remembered "told" would swallow the
  // draft — leaving the user with the one tap that had nothing to read.
  it("announces the draft to someone it told five minutes ago that the run failed", () => {
    const told = { at: "2026-08-21T10:00:00.000Z", drafted: false };
    expect(pendingNews(artifact({ notified: told }), true)).toBeNull();
    expect(pendingNews(artifact({ status: "ready", notified: told }), true)?.draft).toEqual({
      recommendation: null,
      blockers: 0,
    });
  });

  // A PR you have been told about is not news for getting worse.
  it("stays quiet when a row it announced as drafted breaks again", () => {
    const told = { at: "2026-08-21T10:00:00.000Z", drafted: true };
    expect(pendingNews(artifact({ status: "ready", notified: told }), true)).toBeNull();
    expect(pendingNews(artifact({ status: "failed", notified: told }), true)).toBeNull();
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
  const n = { title: "widgets#7 awaits your review", body: "feat: add sprockets — mira", url: null };

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
    const dashed = { title: "widgets#7 awaits your review", body: "--help me — mira", url: null };
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
    await notify({ title: "widgets#7 awaits your review", body: "feat: add sprockets — mira", url: null }, "linux");
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
      notify(
        { title: "widgets#7 awaits your review", body: "feat: add sprockets — mira", url: null },
        "linux",
      ),
    ).resolves.toBe(false);
  });
});

describe("where a click on the tap lands", () => {
  const cockpit = "http://127.0.0.1:4820/";

  // The whole point of the macOS app below: a notification can only open the
  // app that posted it, so what it opens has to be carried on the notice.
  it("sends a one-PR notice to that review, not the queue", () => {
    expect(notice([pr(7)], cockpit)?.url).toBe("http://127.0.0.1:4820/#/r/acme__widgets__7");
  });

  it("sends a batch to the queue, because it is about no single review", () => {
    expect(notice([pr(1), pr(2)], cockpit)?.url).toBe(cockpit);
  });

  // The token rides in the query, ahead of the fragment, so a deep link through
  // it still authenticates and still lands on the review.
  it("keeps a token'd cockpit's query ahead of the deep link", () => {
    expect(notice([pr(7)], "http://127.0.0.1:4820/?token=hunter2")?.url).toBe(
      "http://127.0.0.1:4820/?token=hunter2#/r/acme__widgets__7",
    );
  });

  it("says null when there is no cockpit to open", () => {
    expect(notice([pr(7)])?.url).toBeNull();
    expect(notice([pr(7)], null)?.url).toBeNull();
  });
});

// The app reads the notice back by line, so a line break in it is not a
// cosmetic problem: the body would arrive as the URL and be opened.
describe("the notice the app reads back", () => {
  it("is title, body and target, one line each", () => {
    expect(pendingPayload({ title: "t", body: "b", url: "http://x/" })).toBe("t\nb\nhttp://x/\n");
  });

  it("still has three lines when there is nowhere to click to", () => {
    expect(pendingPayload({ title: "t", body: "b", url: null }).split("\n")).toHaveLength(4);
  });

  it("flattens a PR title that would otherwise shift every line after it", () => {
    expect(pendingPayload({ title: "wob\nble", body: "b\nc", url: null })).toBe("wob ble\nb c\n\n");
  });

  // A draft-ready notice carries the PR title inside its *body*, one field over
  // from where an arrival carries it — so the flattening has to hold for both
  // shapes, not just the one that existed when it was written.
  it("flattens the title a drafted notice carries in its body", () => {
    const n = notice([
      { ...pr(7, { title: "fix: the\nwobble" }), draft: { recommendation: "approve", blockers: 0 } },
    ])!;
    expect(pendingPayload(n).split("\n")).toHaveLength(4);
    expect(pendingPayload(n)).toContain("approves — fix: the wobble");
  });
});

// A click reaches the app with no arguments, so one app holds one target and
// two outstanding notifications cannot be told apart. Opening the wrong PR is
// the failure to avoid; opening the queue is not.
describe("a second notice while the first is still sitting there", () => {
  const deep = "http://127.0.0.1:4820/#/r/acme__widgets__7";

  it("deep-links when nothing else is waiting to be clicked", () => {
    expect(clickTarget(deep, false)).toBe(deep);
  });

  it("falls back to the queue rather than opening the wrong review", () => {
    expect(clickTarget(deep, true)).toBe("http://127.0.0.1:4820/");
  });

  it("keeps a token'd cockpit's query when it drops the deep link", () => {
    expect(clickTarget("http://127.0.0.1:4820/?token=hunter2#/r/acme__widgets__7", true)).toBe(
      "http://127.0.0.1:4820/?token=hunter2",
    );
  });

  it("leaves a batch's target alone — it already points at the queue", () => {
    expect(clickTarget("http://127.0.0.1:4820/", true)).toBe("http://127.0.0.1:4820/");
  });

  it("has nothing to fall back to when there was nowhere to click", () => {
    expect(clickTarget(null, true)).toBeNull();
  });
});

describe("the app cerber posts through", () => {
  it("tells a click apart from a post by whether a notice is waiting", () => {
    const src = appletSource("/home/notify");
    // Destructive read: posting consumes the notice, so the next launch — the
    // click — finds none and opens where that one pointed instead.
    expect(src).toContain('"/home/notify/pending.txt"');
    expect(src).toContain("rm -f");
    expect(src).toContain('"/home/notify/url.txt"');
    expect(src).toContain("on reopen");
  });

  // What makes the fallback above self-healing: the target is consumed by the
  // click, so the next notice after one deep-links again.
  it("consumes the click target on the way out, as it does the notice", () => {
    const src = appletSource("/home/notify");
    expect(src).toContain('rm -f " & quoted form of urlFile');
  });

  // A home folder is somebody's name, and names can hold quotes.
  it("cannot be broken out of by a quote in the path", () => {
    expect(appletSource('/home/o"neill/notify')).toContain('"/home/o\\"neill/notify/pending.txt"');
  });
});

// Three things macOS checks before it will deliver a notification, each of
// which it fails silently: an identity, a seal that matches it, and an icon
// that isn't the generic script one. Only testable where those tools are.
describe.skipIf(process.platform !== "darwin")("building that app", () => {
  it("leaves a bundle the notification centre will accept", async () => {
    const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cerber-notify-"));
    const before = process.env.CERBER_HOME;
    process.env.CERBER_HOME = home;
    // The real tools, not the mock: this test is about what they produce.
    execFileMock.mockImplementation(
      (file: string, args: string[], _opts: unknown, cb: (e: unknown) => void) => {
        try {
          real.execFileSync(file, args, { stdio: "ignore" });
          cb(null);
        } catch (err) {
          cb(err);
        }
      },
    );
    try {
      const app = await ensureNotifierApp();
      expect(app).toBe(path.join(home, "Cerber.app"));
      const contents = path.join(app!, "Contents");
      // An identity, or usernoted denies the notification without asking.
      expect(await fs.readFile(path.join(contents, "Info.plist"), "utf8")).toContain(BUNDLE_ID);
      // A seal that matches it: editing the plist breaks the signature
      // osacompile leaves, and a broken seal is denied just as silently.
      expect(() => real.execFileSync("codesign", ["--verify", app!], { stdio: "ignore" })).not.toThrow();
      // The paw, which only shows once the applet's asset catalogue is gone.
      await expect(fs.stat(path.join(contents, "Resources", "Assets.car"))).rejects.toThrow();
      await expect(fs.stat(path.join(contents, "Resources", "applet.icns"))).resolves.toBeTruthy();
      // And nothing half-built left beside it: a second bundle here carries
      // cerber's own identifier, and a launch reaching it mid-build puts up
      // AppleScript's "Press Run to run this script" dialog.
      expect((await fs.readdir(home)).filter((e) => e.endsWith(".app"))).toEqual(["Cerber.app"]);
    } finally {
      if (before === undefined) delete process.env.CERBER_HOME;
      else process.env.CERBER_HOME = before;
      await fs.rm(home, { recursive: true, force: true });
    }
  }, 30_000);

  it("does not try the build again once it has failed", async () => {
    // One build per process, so a machine that cannot build one doesn't spend a
    // timeout on it every time a PR lands.
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cerber-notify-"));
    const before = process.env.CERBER_HOME;
    process.env.CERBER_HOME = home;
    execFileMock.mockImplementation((_f: string, _a: string[], _o: unknown, cb: (e: unknown) => void) =>
      cb(new Error("no osacompile here")),
    );
    try {
      expect(await ensureNotifierApp()).toBeNull();
      const spent = execFileMock.mock.calls.length;
      expect(await ensureNotifierApp()).toBeNull();
      expect(execFileMock.mock.calls.length).toBe(spent);
    } finally {
      if (before === undefined) delete process.env.CERBER_HOME;
      else process.env.CERBER_HOME = before;
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
