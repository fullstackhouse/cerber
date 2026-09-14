// Desktop notifications for PRs that land while you are somewhere else.
//
// The cockpit spends its day as a background tab, so the queue growing is the
// one thing that should reach through it. Everything here is browser state:
// the permission belongs to this browser, so the switch and the record of what
// has already been announced live in localStorage rather than in config.json.
//
// One popup per piece of news, at the moment it is worth coming back for: with
// auto-review on that is the draft landing, not the PR arriving — see
// `isNews`, the same rule the daemon's own tap applies in
// `src/core/notify.ts`. A PR has at most two such moments, and only ever gets
// the second when the first was "nobody is drafting this".

import { useEffect, useRef, useState } from "react";
import { fetchDaemonStatus, fetchReviews } from "./api";
import { walkable } from "./inbox";
import { DaemonStatus, ReviewListItem } from "./types";

const SEEN = "cerber.notify.seen";
const PREF = "cerber.notify";

/** Same cadence as the queue's own refresh — a PR is news within ten seconds. */
const POLL_MS = 10_000;

/** A finished draft is news about what it found, not about the PR arriving. */
const drafted = (r: ReviewListItem) => r.status === "ready";

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage refused (private mode, a locked-down profile). Notifications
    // still work for this tab; a reload just starts the record over.
  }
};

/**
 * Whether the daemon is drafting for you, which is what decides whether an
 * undrafted row's arrival is the news or its draft will be.
 *
 * `null` is a status read that failed, and it answers nothing: taken for a no,
 * it announces a row the daemon is drafting at that moment, records it as seen,
 * and leaves the real draft-ready tap to arrive second — an early popup and a
 * duplicate, from one hiccup. So the last answer that worked stands.
 */
export function daemonDrafts(daemon: DaemonStatus | null, lastKnown: boolean): boolean {
  if (!daemon) return lastKnown;
  return Boolean(daemon.enabled && daemon.pollEnabled && daemon.autoReview);
}

/**
 * Whether this row is news *yet* — the browser half of the rule the daemon
 * applies in `src/core/notify.ts`, kept deliberately identical so one PR never
 * gets announced at two different moments by two different bells.
 *
 * A row cerber is about to draft, or is drafting, is held back: a popup that
 * leads to "no run yet" is a walk back to the cockpit for nothing, and the
 * moment worth being told about — the draft landing — would then pass in
 * silence. Nothing is coming when auto-review is off, or when the run failed,
 * and then the arrival is the news after all.
 */
export function isNews(r: ReviewListItem, autoReview: boolean): boolean {
  if (r.status === "running") return false;
  if (r.status === "awaiting") return !autoReview;
  return true;
}

/**
 * What the seen-set records for a row, by the news it currently carries.
 *
 * Two things can be announced about one PR — "nobody is drafting this" and
 * "here is the draft" — and the daemon's ledger distinguishes them, because a
 * run that failed is retried and may then succeed. A bare key cannot say which
 * one was told, so a drafted row gets a key of its own; anything else records
 * the plain one.
 */
const draftKey = (r: ReviewListItem) => `${r.key}:draft`;
const newsKey = (r: ReviewListItem) => (drafted(r) ? draftKey(r) : r.key);

/**
 * New to this browser: a PR the queue wants you to look at whose *current news*
 * has never been announced here. Settled, sent and archived reviews are not
 * arrivals — `walkable` is the same list the ‹ › arrows walk.
 */
export function arrivals(
  list: ReviewListItem[],
  seen: string[],
  autoReview: boolean,
): ReviewListItem[] {
  const known = new Set(seen);
  return walkable(list).filter((r) => isNews(r, autoReview) && !known.has(newsKey(r)));
}

/**
 * What to remember after a poll: every key the server knows, not just the ones
 * in the queue. A review you send or skip leaves the queue but stays on disk,
 * and forgetting it would announce it again the day it comes back.
 *
 * Two rows are treated specially, and both mirror the daemon's ledger:
 *
 *   - one being held back for its draft (`isNews`) keeps only what was already
 *     recorded for it. Recording it afresh would spend its announcement on the
 *     silence; dropping what it had would re-announce a draft it already
 *     announced, every time a re-review passes back through `running`.
 *   - one that has a draft records both keys, so what it says next — a broken
 *     re-review, a row reopened — is not announced a second time. A PR you have
 *     been told about is not news for getting worse.
 */
export function announced(
  list: ReviewListItem[],
  autoReview: boolean,
  before: string[] = [],
): string[] {
  const known = new Set(before);
  const inQueue = new Set(walkable(list).map((r) => r.key));
  const out: string[] = [];
  for (const r of list) {
    if (inQueue.has(r.key) && !isNews(r, autoReview)) {
      for (const k of [r.key, draftKey(r)]) if (known.has(k)) out.push(k);
      continue;
    }
    out.push(r.key);
    // Kept once earned: a row whose draft was announced stays quiet through a
    // re-review that breaks and one that then succeeds. Without the last
    // clause, `failed` would drop the draft key and the next success would
    // read as a draft nobody had been told about. A settled row is done being
    // news whatever happens to it next.
    if (drafted(r) || !inQueue.has(r.key) || known.has(draftKey(r))) out.push(draftKey(r));
  }
  return out;
}

export interface Notice {
  title: string;
  body: string;
  /** Collapses the same news into one popup when two cockpit tabs are open. */
  tag: string;
  /** The review to open on click, when the notice is about exactly one. */
  key: string | null;
}

const slug = (r: ReviewListItem) => `${r.pr.repo}#${r.pr.number}`;

const VERDICT_WORDS = {
  approve: "approves",
  comment: "comments",
  request_changes: "requests changes",
} as const;

/** What that draft says, in the few words a popup gets. */
function draftLine(r: ReviewListItem): string {
  const verdict = r.verdict ? VERDICT_WORDS[r.verdict.recommendation] : "drafted";
  const blockers = r.blockerCount ?? 0;
  if (blockers === 0) return verdict;
  return `${verdict} · ${blockers} blocker${blockers === 1 ? "" : "s"}`;
}

/** One popup for one poll's news — a batch is one interruption, not five. */
export function notice(arrived: ReviewListItem[]): Notice | null {
  if (arrived.length === 0) return null;
  // Keyed by the *news*, not the PR: a draft-ready popup arriving while the
  // "run failed" one is still on screen must be a new alert, and a tag it
  // shares would quietly replace that one instead (`renotify` defaults false).
  // Two tabs seeing the same news still tag it identically, which is the job
  // the tag was added for.
  const tag = `cerber:${arrived.map(newsKey).sort().join("|")}`;
  if (arrived.length === 1) {
    const r = arrived[0]!;
    return {
      title: drafted(r) ? `${slug(r)} draft ready` : `${slug(r)} awaits your review`,
      body: drafted(r) ? `${draftLine(r)} — ${r.pr.title}` : `${r.pr.title} — ${r.pr.author}`,
      tag,
      key: r.key,
    };
  }
  const named = arrived.slice(0, 3).map(slug);
  const rest = arrived.length - named.length;
  return {
    // A drafted PR awaits you too, so the general wording is true of any batch;
    // the better headline is only claimed when every one of them is drafted.
    title: arrived.every(drafted) ? `${arrived.length} drafts ready` : `${arrived.length} PRs await your review`,
    body: rest > 0 ? `${named.join(", ")} and ${rest} more` : named.join(", "),
    tag,
    key: null,
  };
}

/** Hosts that mean the cockpit and the `serve` behind it are one machine. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Whether the machine this page is on already gets tapped by the daemon, in
 * which case this bell would be a second popup about one PR.
 *
 * The host test is what keeps a remote cockpit ringing. `cerber serve -H
 * 0.0.0.0 --token` on a VPS notifies the VPS, where nobody is looking, so the
 * browser's bell is that setup's only channel — and deferring to a notifier
 * you cannot see is how a notification quietly stops existing.
 */
export function daemonAnnouncesHere(
  daemon: DaemonStatus | null,
  hostname: string = window.location.hostname,
): boolean {
  if (!daemon?.enabled || !daemon.notify) return false;
  return LOOPBACK.has(hostname);
}

/**
 * What the bell says. `ask` is the default state of a fresh browser: cerber
 * wants to notify you, but only the browser can grant that, and only off a
 * click.
 */
export type NotifyState = "unsupported" | "blocked" | "off" | "ask" | "on";

export function notifyState(): NotifyState {
  if (typeof Notification === "undefined") return "unsupported";
  // The browser's no beats our yes, and saying "off" here would offer a switch
  // that cannot flip.
  if (Notification.permission === "denied") return "blocked";
  if (read(PREF) === "off") return "off";
  return Notification.permission === "granted" ? "on" : "ask";
}

/** The bell's one click: ask the browser the first time, toggle after that. */
export async function toggleNotifications(): Promise<NotifyState> {
  const state = notifyState();
  if (state === "unsupported" || state === "blocked") return state;
  if (state === "on") {
    write(PREF, "off");
    return notifyState();
  }
  write(PREF, "on");
  if (Notification.permission === "default") {
    try {
      await Notification.requestPermission();
    } catch {
      // Older Safari hands the answer to a callback and returns nothing; the
      // state re-read below still sees whatever the user chose.
    }
  }
  return notifyState();
}

function show(n: Notice) {
  const popup = new Notification(n.title, { body: n.body, tag: n.tag, icon: "/favicon.svg" });
  popup.onclick = () => {
    window.focus();
    window.location.hash = n.key ? `#/r/${encodeURIComponent(n.key)}` : "#/";
    popup.close();
  };
}

/**
 * Watch the queue for arrivals from wherever in the cockpit you are. It polls
 * on its own rather than riding the queue screen's poll: that one stops the
 * moment you open a review, and a notification you only get on one screen is a
 * default that half-works.
 *
 * Returns whether the daemon is announcing arrivals on this machine already —
 * the one case where this hook deliberately watches in silence, and what the
 * bell in the top bar says instead of claiming a job it isn't doing.
 */
export function useArrivalNotifications(): boolean {
  // Null until the first response lands. A browser that has never seen this
  // queue must not announce the whole backlog, so the first poll only records.
  const seen = useRef<string[] | null>(null);
  /**
   * What the last status read that worked said about drafting. It starts at
   * "drafting", the conservative end: holding a row back only ever delays its
   * notice, since a held-back row is not recorded as seen either, so the first
   * successful read announces it properly.
   */
  const drafting = useRef(true);
  const [daemonAnnounces, setDaemonAnnounces] = useState(false);

  useEffect(() => {
    let alive = true;
    const stored = read(SEEN);
    if (stored) {
      try {
        const parsed: unknown = JSON.parse(stored);
        if (Array.isArray(parsed)) seen.current = parsed.filter((k): k is string => typeof k === "string");
      } catch {
        // Hand-mangled or from an older shape — start the record over.
      }
    }

    const tick = () =>
      Promise.all([fetchReviews(), fetchDaemonStatus().catch(() => null)])
        .then(([list, daemon]) => {
          if (!alive) return;
          const machineHasIt = daemonAnnouncesHere(daemon);
          setDaemonAnnounces(machineHasIt);
          // Whether anything is coming for an undrafted row, which is what says
          // if its arrival is the news or the draft is.
          drafting.current = daemonDrafts(daemon, drafting.current);
          const autoReview = drafting.current;
          const before = seen.current;
          // Recorded even when we stay quiet, so turning the bell on later
          // announces what arrives next rather than everything already here.
          seen.current = announced(list, autoReview, before ?? []);
          write(SEEN, JSON.stringify(seen.current));
          if (!before) return;
          if (notifyState() !== "on") return;
          // The daemon taps this same machine off the same arrival: one popup
          // per PR, and its one is the one that works with no tab open.
          if (machineHasIt) return;
          // Looking straight at the queue? The row appearing is the notice.
          if (document.visibilityState === "visible" && document.hasFocus()) return;
          const n = notice(arrivals(list, before, autoReview));
          if (n) show(n);
        })
        .catch(() => {
          // A dead server is the queue screen's story to tell, not the bell's.
        });

    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return daemonAnnounces;
}

/** The bell's state, kept in sync with the browser's own permission prompt. */
export function useNotifyState(): [NotifyState, () => void] {
  const [state, setState] = useState<NotifyState>(notifyState);
  useEffect(() => {
    // Permission can also change from the browser's own UI (the padlock menu),
    // which fires no event anywhere — re-read it when the tab comes back.
    const sync = () => setState(notifyState());
    window.addEventListener("focus", sync);
    return () => window.removeEventListener("focus", sync);
  }, []);
  return [state, () => void toggleNotifications().then(setState)];
}
