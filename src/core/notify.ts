// The machine's own shoulder-tap, for the hours the cockpit isn't open.
//
// The cockpit has a bell of its own (`web/src/notify.ts`), and it is the better
// one when it can ring: it names the PR and opens that review when you click
// it. But it is a page notification, so it needs a tab that is open, alive and
// permitted — which is exactly what you don't have while you're in an editor
// all afternoon. This half rides the poll that discovers the PR instead, so the
// tap survives a closed cockpit, a denied permission and a browser restart.
//
// Everything here shells out to whatever the OS already has. No dependency, no
// daemon of its own, and a machine with no notifier is a machine cerber stays
// quiet on rather than one it fails on.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** One PR that has just landed in the queue. */
export interface Arrival {
  repo: string;
  number: number;
  title: string;
  author: string;
}

export interface Notice {
  title: string;
  body: string;
}

const slug = (a: Arrival) => `${a.repo}#${a.number}`;

/**
 * One popup for one poll's arrivals — a batch is one interruption, not five.
 * Deliberately the same shape and wording the cockpit's bell uses, so the two
 * channels never read as two different pieces of news about one PR.
 */
export function notice(arrived: Arrival[]): Notice | null {
  if (arrived.length === 0) return null;
  if (arrived.length === 1) {
    const a = arrived[0]!;
    return { title: `${slug(a)} awaits your review`, body: `${a.title} — ${a.author}` };
  }
  const named = arrived.slice(0, 3).map(slug);
  const rest = arrived.length - named.length;
  return {
    title: `${arrived.length} PRs await your review`,
    body: rest > 0 ? `${named.join(", ")} and ${rest} more` : named.join(", "),
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
    // `--` first: a PR title is somebody else's text, and notify-send parses
    // options before positionals — a title beginning with `-` would be read as
    // a flag and cost the notification. The marker ends option parsing, so the
    // title and body can only ever be the summary and the body.
    return { file: "notify-send", args: ["--app-name=cerber", "--", n.title, n.body] };
  }
  return null;
}

/**
 * Show it, and say whether it was shown. False is an ordinary answer here —
 * an unsupported platform, no `notify-send` installed, a headless box — and the
 * caller reports it once rather than every poll. Never throws: a notification
 * is the least important thing a poll does.
 */
export async function notify(n: Notice): Promise<boolean> {
  const cmd = notifyCommand(n);
  if (!cmd) return false;
  try {
    await execFileAsync(cmd.file, cmd.args);
    return true;
  } catch {
    return false;
  }
}
