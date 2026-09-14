// The machine's own shoulder-tap, for the hours the cockpit isn't open.
//
// The cockpit has a bell of its own (`web/src/notify.ts`), and it is the better
// one when it can ring: it names the PR and opens that review when you click
// it. But it is a page notification, so it needs a tab that is open, alive and
// permitted — which is exactly what you don't have while you're in an editor
// all afternoon. This half rides the poll instead, so the tap survives a closed
// cockpit, a denied permission and a browser restart.
//
// It taps you once per piece of news, at the moment that news is worth walking
// back for. With auto-review on — the default — that is when the draft is
// written, not when the PR lands: a tap that leads to "no run yet, press r" is
// a tap that costs you the walk back and gives you nothing. `isNews` decides
// whether there is news at all, `pendingNews` whether it is news you have
// already been told. A PR has at most two: "nobody is drafting this", and
// "here is the draft" — and it only gets the second if it got the first.
//
// A click has to land in the same place either way, which on macOS is the whole
// difference between the two paths below. `osascript -e 'display notification'`
// posts as Script Editor — that is the app macOS sees making the call — so
// clicking the tap opens Script Editor, an app the user never asked for and a
// dead end from a notification about a PR. A notification can only open what
// posted it, so cerber posts its own: a small app bundle built once under
// `~/.cerber`, which opens the review in the cockpit when clicked. Where it
// can't be built, the plain `osascript` tap is still better than silence.
//
// Everything here shells out to whatever the OS already has. No dependency, no
// daemon of its own, and a machine with no notifier is a machine cerber stays
// quiet on rather than one it fails on.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { artifactId, artifactKey } from "./artifact.js";
import type { Artifact, Verdict } from "./artifact.js";
import { cerberHome } from "./state.js";

const execFileAsync = promisify(execFile);

/**
 * How long a notifier gets before the poll stops waiting for it.
 *
 * A notification is instant or it is broken, and the thing on the other end of
 * this is somebody else's daemon: a wedged Notification Centre or a DBus that
 * never answers would otherwise hang `execFile` forever. The poll awaits this
 * call, and the daemon refuses to start a poll while one is running — so an
 * unbounded wait here doesn't cost one notification, it stops cerber
 * discovering PRs at all. Timing out is caught like any other failure.
 */
export const NOTIFY_TIMEOUT_MS = 5_000;

/** What cerber has to say about a PR: it wants you, and maybe it is drafted. */
export interface Arrival {
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  /**
   * The draft waiting on it, when *that* is the news. Null makes this a plain
   * arrival — a PR nobody is going to draft for you (auto-review off), or one
   * whose run failed. Either way the news is that it wants you, not that there
   * is something written to read.
   */
  draft?: DraftNews | null;
}

/** The one line of a finished draft a notification has room for. */
export interface DraftNews {
  recommendation: Verdict["recommendation"] | null;
  blockers: number;
}

export interface Notice {
  title: string;
  body: string;
  /**
   * Where a click on it should land, or null when cerber has nowhere to send
   * one — `serve` on a port it can't name, or a notice raised outside it.
   */
  url: string | null;
}

const slug = (a: Arrival) => `${a.repo}#${a.number}`;

const VERDICT_WORDS: Record<Verdict["recommendation"], string> = {
  approve: "approves",
  comment: "comments",
  request_changes: "requests changes",
};

/**
 * What a finished draft says, in the few words a popup gets: the verdict, and
 * the count the verdict rests on. A draft that graded nothing and left no
 * verdict still gets a line — "drafted" is the news there.
 */
function draftLine(d: DraftNews): string {
  const verdict = d.recommendation ? VERDICT_WORDS[d.recommendation] : "drafted";
  if (d.blockers === 0) return verdict;
  return `${verdict} · ${d.blockers} blocker${d.blockers === 1 ? "" : "s"}`;
}

/**
 * Text a notification body or an AppleScript literal can actually hold. A PR
 * title is somebody else's text and can carry anything; control characters
 * collapse to a space rather than splitting a line the applet reads back by
 * line, or ending a string literal early.
 */
const flatten = (value: string) => value.replace(/[\u0000-\u001f\u007f]+/g, " ");

/**
 * One popup for one poll's news — a batch is one interruption, not five.
 * Deliberately the same shape and wording the cockpit's bell uses, so the two
 * channels never read as two different pieces of news about one PR.
 *
 * `cockpit` is where clicking it lands: the review itself when the notice is
 * about exactly one PR, the queue when it is about several. It must be an
 * origin with no fragment of its own — the deep link is a fragment, and the
 * cockpit is a hash-routed page.
 */
export function notice(news: Arrival[], cockpit?: string | null): Notice | null {
  if (news.length === 0) return null;
  const base = cockpit || null;
  if (news.length === 1) {
    const a = news[0]!;
    const key = artifactKey(artifactId(a));
    const url = base && `${base}#/r/${encodeURIComponent(key)}`;
    // The draft is the news when there is one, so the popup leads with what it
    // found rather than with the PR having arrived — which, by then, it did
    // minutes ago.
    if (a.draft) return { title: `${slug(a)} draft ready`, body: `${draftLine(a.draft)} — ${a.title}`, url };
    return { title: `${slug(a)} awaits your review`, body: `${a.title} — ${a.author}`, url };
  }
  const named = news.slice(0, 3).map(slug);
  const rest = news.length - named.length;
  return {
    // A drafted PR awaits you too, so the general wording is true of any batch;
    // the better headline is only claimed when every one of them is drafted.
    title: news.every((n) => n.draft) ? `${news.length} drafts ready` : `${news.length} PRs await your review`,
    body: rest > 0 ? `${named.join(", ")} and ${rest} more` : named.join(", "),
    url: base,
  };
}

/**
 * Whether this row is news *yet*.
 *
 * The one rule behind the tap's timing, and the cockpit's bell mirrors it
 * (`web/src/notify.ts`). A row cerber is about to draft, or is drafting, is not
 * news: the tap would arrive minutes before there is anything to read, and the
 * one after it would never come. So it waits — unless nothing is coming, which
 * is the case when auto-review is off (nobody will draft this until you say so)
 * or the run failed (nobody will draft it at all).
 *
 * A row you have settled is not news either, whatever else happened to it: you
 * already answered it.
 */
export function isNews(a: Artifact, autoReview: boolean): boolean {
  if (a.pr.state !== "OPEN") return false;
  if (a.status === "running") return false;
  if (a.status === "awaiting") return !autoReview;
  return a.status === "ready" || a.status === "failed";
}

/**
 * What this row has to say that it has not said already, or null for silence.
 *
 * `isNews` answers "is there news at all"; this one also weighs it against the
 * ledger, which is where the two things cerber can say about a row stop being
 * interchangeable. A run that failed is announced as "nobody is drafting this",
 * is retried on the next poll, and may then succeed — so the draft is news
 * *again*, to someone who was told the opposite five minutes ago. The reverse
 * is not: a row that had a draft and now has a broken re-review is a PR the
 * user already knows about, and a second tap there is noise.
 */
export function pendingNews(a: Artifact, autoReview: boolean): Arrival | null {
  // Absent, not null: nobody ever meant to announce this row.
  if (a.notified === undefined) return null;
  if (!isNews(a, autoReview)) return null;
  const news = newsOf(a);
  if (a.notified === null) return news;
  return news.draft && !a.notified.drafted ? news : null;
}

/** What that row would say, for the one notice a poll sends. */
export function newsOf(a: Artifact): Arrival {
  return {
    // The click target is built from the ref, so the owner travels with it.
    owner: a.pr.owner,
    repo: a.pr.repo,
    number: a.pr.number,
    title: a.pr.title,
    author: a.pr.author,
    draft:
      a.status === "ready"
        ? {
            recommendation: a.verdict?.recommendation ?? null,
            blockers: a.comments.filter((c) => c.status !== "dropped" && c.severity === "blocker").length,
          }
        : null,
  };
}

/**
 * A PR title, as an AppleScript string literal.
 *
 * osascript takes a script, not an argument list, so the title has to go into
 * the source — and a PR title is text somebody else wrote. Escaping the two
 * characters a literal cannot hold, a backslash and a quote, is what stops a
 * title from closing the string and being read as script. Control characters
 * can't appear in a literal at all, so they collapse to a space.
 */
export function appleScriptLiteral(value: string): string {
  return `"${flatten(value).replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/**
 * The command that taps this machine's notification centre, or null where there
 * is nothing to tap. macOS and the freedesktop notifiers cover what cerber runs
 * on; anywhere else it stays quiet rather than pretending.
 *
 * On macOS this is the fallback rather than the first choice — see
 * `ensureNotifierApp` for the one whose click opens the review.
 */
export function notifyCommand(
  n: Notice,
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } | null {
  if (platform === "darwin") {
    return {
      file: "osascript",
      args: [
        "-e",
        `display notification ${appleScriptLiteral(n.body)} with title ${appleScriptLiteral(n.title)}`,
      ],
    };
  }
  if (platform === "linux") {
    // `--` first, because notify-send parses options before positionals. The
    // PR's own title reaches this as the notice *body* (`notice()` builds the
    // summary itself), so the body is the argument carrying somebody else's
    // text — a PR titled "--help me" would be read as a flag and cost the
    // notification. The marker ends option parsing ahead of both arguments, so
    // neither the summary nor the body can be read as anything but text.
    return { file: "notify-send", args: ["--app-name=cerber", "--", n.title, n.body] };
  }
  return null;
}

/**
 * What the notification centre knows cerber by. Permission is granted to this
 * identifier, once, by the user — so it has to survive every rebuild, or each
 * new version of cerber would ask for notifications again as a stranger.
 */
export const BUNDLE_ID = "house.fullstack.cerber";

/** Bumped whenever the applet or its plist changes, so an installed app is replaced. */
const APP_BUILD = "3";

const ICON = fileURLToPath(new URL("../../assets/cerber.icns", import.meta.url));

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/**
 * The app's whole job, in the only language a bundle this small can be written
 * in without a compiler on the user's machine.
 *
 * It is launched twice per notification and has to tell the two apart with no
 * arguments, because a click gives it none: macOS just opens the app that
 * posted the notification. The pending file is what distinguishes them, and
 * reading it is destructive — a launch that finds a notice posts it, a launch
 * that finds none is the click on the last one, and opens where that one
 * pointed. Nothing else can put the app in either state, so the two can't be
 * confused.
 *
 * The paths are baked in rather than derived from the home folder, so a cerber
 * running under CERBER_HOME talks to the app it actually built.
 */
export function appletSource(dir: string): string {
  const pending = appleScriptLiteral(path.join(dir, "pending.txt"));
  const landing = appleScriptLiteral(path.join(dir, "url.txt"));
  // `on run` is a launch from cold, `on reopen` a click while it is still up
  // after posting — same job either way.
  return `on run
	tap()
end run

on reopen
	tap()
end reopen

on tap()
	set pendingFile to ${pending}
	set urlFile to ${landing}
	try
		set raw to do shell script "cat " & quoted form of pendingFile & " 2>/dev/null; rm -f " & quoted form of pendingFile
	on error
		set raw to ""
	end try
	if raw is "" then
		try
			set target to do shell script "cat " & quoted form of urlFile & " 2>/dev/null"
		on error
			set target to ""
		end try
		-- Consumed on the way out, the same way the notice was: what is left
		-- behind is what cerber reads as "an earlier notification is still
		-- sitting there unclicked".
		if target is not "" then
			do shell script "open " & quoted form of target & "; rm -f " & quoted form of urlFile
		else
			do shell script "rm -f " & quoted form of urlFile
		end if
		return
	end if
	-- do shell script hands back the lines separated by return, not linefeed.
	set AppleScript's text item delimiters to return
	set parts to text items of raw
	if (count of parts) < 2 then return
	set target to ""
	if (count of parts) > 2 then set target to item 3 of parts
	-- umask, because the target carries the cockpit's token: nothing here is
	-- another account's business to read.
	do shell script "umask 077; printf %s " & quoted form of target & " > " & quoted form of urlFile
	display notification (item 2 of parts) with title (item 1 of parts)
end tap
`;
}

/**
 * Where a notice may point, given whether an earlier one is still sitting
 * unclicked in Notification Centre.
 *
 * A click reaches the app with no arguments — macOS just opens whatever posted
 * the notification — so one app can hold exactly one click target, and two
 * outstanding notifications cannot be told apart. Pointing both at the newest
 * review would open the wrong PR from the older notification, silently and
 * convincingly. So the second one drops its fragment and both land on the
 * queue, where every arrival is a row: less specific, never wrong.
 *
 * It heals itself. The target is consumed by the click that follows it, so the
 * next notice after any click deep-links again; only a run of notifications
 * nobody touches stays on the queue.
 */
export function clickTarget(url: string | null, outstanding: boolean): string | null {
  if (!url || !outstanding) return url;
  const fragment = url.indexOf("#");
  return fragment < 0 ? url : url.slice(0, fragment);
}

/**
 * The notice, as the app reads it back: title, body and click target, one line
 * each. Flattened first — a newline in a PR title would otherwise shift every
 * line after it, and the body would arrive as the URL.
 */
export function pendingPayload(n: Notice): string {
  return `${flatten(n.title)}\n${flatten(n.body)}\n${flatten(n.url ?? "")}\n`;
}

async function run(file: string, args: string[]): Promise<void> {
  await execFileAsync(file, args, { timeout: NOTIFY_TIMEOUT_MS });
}

/**
 * Set a key in the applet's Info.plist whether or not it is already there.
 *
 * `plutil -replace` is documented as overwriting an *existing* value — it does
 * create a missing key in practice, but on undocumented behaviour, and every
 * key this sets is one `osacompile` may or may not have written. A failure
 * here fails the build and silently costs the click, so the documented
 * inserting form is the fallback rather than the assumption.
 */
async function setPlistValue(plist: string, key: string, type: string, value: string) {
  const flags = [key, type, value, plist];
  await run("plutil", ["-replace", ...flags]).catch(() => run("plutil", ["-insert", ...flags]));
}

/**
 * Build the app cerber posts through, into `~/.cerber/Cerber.app`.
 *
 * Three things here are load-bearing, each learned the way macOS teaches them —
 * by dropping the notification and saying nothing:
 *
 *  - **A bundle identifier.** `osacompile` leaves the applet without one, and
 *    a bundle with no identity gets its notifications denied.
 *  - **A signature that matches.** Editing `Info.plist` invalidates the ad-hoc
 *    signature `osacompile` writes, and a bundle whose seal is broken is denied
 *    just as flatly. So it is re-signed, ad-hoc, after the edits.
 *  - **A path LaunchServices will register.** A bundle under `/tmp` is never
 *    resolved to an app, so the request for permission is never even asked.
 *    `~/.cerber` is fine, and `lsregister` makes sure it is known before the
 *    first notification rather than after it.
 */
async function buildNotifierApp(app: string, dir: string): Promise<void> {
  // 0700: the notices left here hold the cockpit's URL, token and all.
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const source = path.join(dir, "applet.applescript");
  await fs.writeFile(source, appletSource(dir));

  // Staged in the one place LaunchServices refuses to register — the same
  // refusal that makes a bundle under /tmp undeliverable also makes it
  // unlaunchable, which is what a half-built app must be. Staged beside the
  // real one it is a second app with cerber's own bundle identifier, and a
  // launch that reaches it mid-build finds an applet with no script yet and
  // puts up AppleScript's "Press Run to run this script" dialog.
  //
  // The name still ends in .app because osacompile picks what it writes from
  // the extension, and anything else gets a bare script file with no bundle
  // around it — no Info.plist, nothing to sign, nothing to post.
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "cerber-notifier-"));
  try {
    await assemble(path.join(stagingDir, "Cerber.app"), app, source);
  } finally {
    // Every attempt, not just the ones that worked: a machine with no
    // osacompile fails here once per process, and each failure would otherwise
    // leave its half-built bundle behind for good.
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
}

/** Everything between an empty staging directory and an installed, signed app. */
async function assemble(staged: string, app: string, source: string): Promise<void> {
  await run("osacompile", ["-o", staged, source]);

  const plist = path.join(staged, "Contents", "Info.plist");
  await setPlistValue(plist, "CFBundleIdentifier", "-string", BUNDLE_ID);
  // An agent, not an app: cerber's notifier has no window and no business in
  // the Dock or the app switcher for the second it spends posting.
  await setPlistValue(plist, "LSUIElement", "-bool", "true");

  // The applet ships an asset catalogue holding the generic script icon, and a
  // catalogue wins over anything in Resources/ — so the paw only lands once the
  // catalogue and the name it answers to are both gone.
  const resources = path.join(staged, "Contents", "Resources");
  await fs.rm(path.join(resources, "Assets.car"), { force: true });
  await run("plutil", ["-remove", "CFBundleIconName", plist]).catch(() => {});
  await fs.copyFile(ICON, path.join(resources, "applet.icns")).catch(() => {
    // No icon is a generic icon, not a failure — the tap still works.
  });

  await run("codesign", ["--force", "--sign", "-", staged]);

  // Not atomic, because a directory swap can't be: the window between these two
  // is a few milliseconds in which a notification would fall back to osascript.
  await fs.rm(app, { recursive: true, force: true });
  try {
    await fs.rename(staged, app);
  } catch {
    // A CERBER_HOME on another volume: rename can't cross one, and a copy
    // carries the signature with it — it lives in the bundle's own files.
    await fs.cp(staged, app, { recursive: true });
  }
  await run(LSREGISTER, ["-f", app]).catch(() => {
    // Best effort: `open` registers the bundle too, just later than we'd like.
  });
}

/**
 * One build attempt per home per process, whatever the answer.
 *
 * The poll awaits `announce`, so retrying a hopeless build every time a PR
 * lands would spend a timeout apiece on a machine that is never going to have
 * `osacompile`. A remembered failure falls back to the plain tap instead.
 */
const builds = new Map<string, Promise<string | null>>();

export function ensureNotifierApp(): Promise<string | null> {
  // Resolved, because the paths go *into* the app: CERBER_HOME may be
  // relative, and an app LaunchServices launches on a click inherits none of
  // the daemon's working directory to resolve it against.
  const home = path.resolve(cerberHome());
  let building = builds.get(home);
  if (!building) {
    building = installNotifierApp(home).catch(() => null);
    builds.set(home, building);
  }
  return building;
}

async function installNotifierApp(home: string): Promise<string | null> {
  const app = path.join(home, "Cerber.app");
  const dir = path.join(home, "notify");
  const stamp = path.join(dir, "build");
  const want = `${APP_BUILD} ${app}\n`;
  const built = await fs
    .stat(path.join(app, "Contents", "Info.plist"))
    .then(() => true)
    .catch(() => false);
  if (built && (await fs.readFile(stamp, "utf8").catch(() => null)) === want) return app;
  await buildNotifierApp(app, dir);
  await fs.writeFile(stamp, want);
  return app;
}

/**
 * Hand the notice to cerber's own app, so a click on it opens the review.
 * False means the app couldn't take it and the caller should fall back — the
 * tap matters more than which app posts it.
 */
async function postThroughApp(n: Notice): Promise<boolean> {
  const app = await ensureNotifierApp();
  if (!app) return false;
  // Beside the app that was actually built, rather than wherever CERBER_HOME
  // points now — the paths the applet reads were baked into it at build time.
  const dir = path.join(path.dirname(app), "notify");
  const file = path.join(dir, "pending.txt");
  const tmp = path.join(dir, `pending.${process.pid}.tmp`);
  try {
    // A target the app hasn't consumed means the notification it belongs to is
    // still there to be clicked, and two of them cannot be told apart.
    const outstanding = await fs
      .stat(path.join(dir, "url.txt"))
      .then(() => true)
      .catch(() => false);
    // tmp+rename, so the app can never read half a notice: it reads the file
    // the instant `open` wakes it, and a partial one would post a PR title cut
    // in two or a URL that leads nowhere.
    // 0600 for the same reason the app's own write is: this line is the
    // cockpit URL, and the cockpit URL carries the token that gets in.
    await fs.writeFile(tmp, pendingPayload({ ...n, url: clickTarget(n.url, outstanding) }), {
      mode: 0o600,
    });
    await fs.rename(tmp, file);
    // -g, so a PR landing doesn't pull focus out of whatever you're doing.
    await run("open", ["-g", app]);
    return true;
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => {});
    return false;
  }
}

/**
 * Show it, and say whether it was shown. False is an ordinary answer here —
 * an unsupported platform, no `notify-send` installed, a headless box, a
 * notifier that took too long — and the caller reports it once rather than
 * every poll. Never throws and never hangs: a notification is the least
 * important thing a poll does, so it is also the last thing allowed to stop
 * one.
 */
export async function notify(
  n: Notice,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform === "darwin" && (await postThroughApp(n))) return true;
  const cmd = notifyCommand(n, platform);
  if (!cmd) return false;
  try {
    await execFileAsync(cmd.file, cmd.args, { timeout: NOTIFY_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}
