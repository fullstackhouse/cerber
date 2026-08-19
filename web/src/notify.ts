// Desktop notifications for PRs that land while you are somewhere else.
//
// The cockpit spends its day as a background tab, so the queue growing is the
// one thing that should reach through it. Everything here is browser state:
// the permission belongs to this browser, so the switch and the record of what
// has already been announced live in localStorage rather than in config.json.

import { useEffect, useRef, useState } from "react";
import { fetchReviews } from "./api";
import { walkable } from "./inbox";
import { ReviewListItem } from "./types";

const SEEN = "cerber.notify.seen";
const PREF = "cerber.notify";

/** Same cadence as the queue's own refresh — a PR is news within ten seconds. */
const POLL_MS = 10_000;

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
 * New to this browser: a PR the queue wants you to look at whose key has never
 * been announced here. Settled, sent and archived reviews are not arrivals —
 * `walkable` is the same list the ‹ › arrows walk.
 */
export function arrivals(list: ReviewListItem[], seen: string[]): ReviewListItem[] {
  const known = new Set(seen);
  return walkable(list).filter((r) => !known.has(r.key));
}

/**
 * What to remember after a poll: every key the server knows, not just the ones
 * in the queue. A review you send or skip leaves the queue but stays on disk,
 * and forgetting it would announce it again the day it comes back.
 */
export function announced(list: ReviewListItem[]): string[] {
  return list.map((r) => r.key);
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

/** One popup for one poll's arrivals — a batch is one interruption, not five. */
export function notice(arrived: ReviewListItem[]): Notice | null {
  if (arrived.length === 0) return null;
  const tag = `cerber:${arrived.map((r) => r.key).sort().join("|")}`;
  if (arrived.length === 1) {
    const r = arrived[0]!;
    return {
      title: `${slug(r)} awaits your review`,
      body: `${r.pr.title} — ${r.pr.author}`,
      tag,
      key: r.key,
    };
  }
  const named = arrived.slice(0, 3).map(slug);
  const rest = arrived.length - named.length;
  return {
    title: `${arrived.length} PRs await your review`,
    body: rest > 0 ? `${named.join(", ")} and ${rest} more` : named.join(", "),
    tag,
    key: null,
  };
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
 */
export function useArrivalNotifications() {
  // Null until the first response lands. A browser that has never seen this
  // queue must not announce the whole backlog, so the first poll only records.
  const seen = useRef<string[] | null>(null);

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
      fetchReviews()
        .then((list) => {
          if (!alive) return;
          const before = seen.current;
          // Recorded even when we stay quiet, so turning the bell on later
          // announces what arrives next rather than everything already here.
          seen.current = announced(list);
          write(SEEN, JSON.stringify(seen.current));
          if (!before) return;
          if (notifyState() !== "on") return;
          // Looking straight at the queue? The row appearing is the notice.
          if (document.visibilityState === "visible" && document.hasFocus()) return;
          const n = notice(arrivals(list, before));
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
