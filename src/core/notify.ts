// The machine's own shoulder-tap, for the hours the cockpit isn't open.
//
// The cockpit has a bell of its own (`web/src/notify.ts`), and it is the better
// one when it can ring: it names the PR and opens that review when you click
// it. But it is a page notification, so it needs a tab that is open, alive and
// permitted — which is exactly what you don't have while you're in an editor
// all afternoon. This half rides the poll instead, so the tap survives a closed
// cockpit, a denied permission and a browser restart.
//
// It taps you once per PR, at the moment that PR is worth walking back to. With
// auto-review on — the default — that is when the draft is written, not when
// the PR lands: a tap that leads to "no run yet, press r" is a tap that costs
// you the walk back and gives you nothing. `isNews` is the whole of that rule.
//
// Everything here shells out to whatever the OS already has. No dependency, no
// daemon of its own, and a machine with no notifier is a machine cerber stays
// quiet on rather than one it fails on.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Artifact, Verdict } from "./artifact.js";

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
 * One popup for one poll's news — a batch is one interruption, not five.
 * Deliberately the same shape and wording the cockpit's bell uses, so the two
 * channels never read as two different pieces of news about one PR.
 */
export function notice(news: Arrival[]): Notice | null {
  if (news.length === 0) return null;
  if (news.length === 1) {
    const a = news[0]!;
    if (a.draft) return { title: `${slug(a)} draft ready`, body: `${draftLine(a.draft)} — ${a.title}` };
    return { title: `${slug(a)} awaits your review`, body: `${a.title} — ${a.author}` };
  }
  const named = news.slice(0, 3).map(slug);
  const rest = news.length - named.length;
  return {
    // A drafted PR awaits you too, so the general wording is true of any batch;
    // the better headline is only claimed when every one of them is drafted.
    title: news.every((n) => n.draft) ? `${news.length} drafts ready` : `${news.length} PRs await your review`,
    body: rest > 0 ? `${named.join(", ")} and ${rest} more` : named.join(", "),
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

/** What that row would say, for the one notice a poll sends. */
export function newsOf(a: Artifact): Arrival {
  return {
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
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, " ");
  return `"${flat.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/**
 * The command that taps this machine's notification centre, or null where there
 * is nothing to tap. macOS and the freedesktop notifiers cover what cerber runs
 * on; anywhere else it stays quiet rather than pretending.
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
 * Show it, and say whether it was shown. False is an ordinary answer here —
 * an unsupported platform, no `notify-send` installed, a headless box, a
 * notifier that took too long — and the caller reports it once rather than
 * every poll. Never throws and never hangs: a notification is the least
 * important thing a poll does, so it is also the last thing allowed to stop
 * one.
 */
export async function notify(n: Notice): Promise<boolean> {
  const cmd = notifyCommand(n);
  if (!cmd) return false;
  try {
    await execFileAsync(cmd.file, cmd.args, { timeout: NOTIFY_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}
