// What the queue knows about a review before you open it.
//
// The cursor row explains itself in the strip under the table — verdict
// reasoning, what the run read, why it is or isn't an auto-send candidate — so
// walking the queue doesn't mean opening every review. These derivations are
// shared with the detail view, whose ‹ › arrows walk the very same list.

import { DaemonStatus, ReviewListItem } from "./types";

export type Tab = "all" | "awaiting" | "drafted" | "sent";

/**
 * The tabs filter the live queue. Sent reviews are records and merged PRs are
 * history — both keep their own drawer under the table rather than a tab, so
 * neither pushes work you haven't done off the top of the list.
 */
export const TABS: Tab[] = ["all", "awaiting", "drafted"];

/** Which filter tab a review belongs to. Every status lands in exactly one. */
export function tabOf(r: ReviewListItem): Exclude<Tab, "all"> {
  if (r.status === "awaiting" || r.status === "running") return "awaiting";
  if (r.status === "sent") return "sent";
  return "drafted";
}

/** Merged and closed PRs drop out of the queue into the archived list. */
export const isArchived = (r: ReviewListItem) => !!r.pr.state && r.pr.state !== "OPEN";

/**
 * How much a review wants you, most first: a finished draft is the thing to
 * read; one nobody has drafted yet is a keypress away; a run in flight will
 * arrive on its own; a failed one needs a hand. Settled reviews sink, and a
 * sent one is history. Newest first inside each band.
 */
const STATUS_ORDER = ["ready", "awaiting", "running", "failed", "reviewed", "skipped", "sent"];

export function sortReviews(list: ReviewListItem[]): ReviewListItem[] {
  return [...list].sort(
    (a, b) =>
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
      b.updatedAt.localeCompare(a.updatedAt),
  );
}

/** Statuses that mean you have dealt with this review, one way or another. */
const SETTLED = ["sent", "reviewed", "skipped"];

/**
 * The reviews the ‹ › arrows walk: open PRs that still want something from you.
 * A sent review is a record and a skipped one is a decision, so walking past
 * either would be walking backwards.
 */
export function walkable(list: ReviewListItem[]): ReviewListItem[] {
  return sortReviews(list.filter((r) => !isArchived(r) && !SETTLED.includes(r.status)));
}

/** "now", "40s", "12m", "2h", "5d" — the queue's `upd` column. */
export function ageLabel(iso: string, now: number = Date.now()): string {
  const secs = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (secs < 45) return "now";
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  if (secs < 86_400) return `${Math.round(secs / 3600)}h`;
  return `${Math.round(secs / 86_400)}d`;
}

export type Tone = "approve" | "comment" | "changes" | "running" | "awaiting" | "sent" | "failed" | "none";

const RECOMMENDATION_TONE: Record<string, Tone> = {
  approve: "approve",
  comment: "comment",
  request_changes: "changes",
};

const EVENT_LABEL: Record<string, string> = {
  APPROVE: "approve",
  COMMENT: "comment",
  REQUEST_CHANGES: "request changes",
};

/** The verdict column: what this row is, in the fewest words that stay true. */
export function verdictCell(r: ReviewListItem): { label: string; tone: Tone } {
  if (r.status === "running") return { label: "reviewing…", tone: "running" };
  if (r.status === "awaiting") return { label: "review now", tone: "awaiting" };
  if (r.status === "failed") return { label: "run failed", tone: "failed" };
  if (r.sent) return { label: `sent · ${EVENT_LABEL[r.sent.event] ?? r.sent.event}`, tone: "sent" };
  if (!r.verdict) return { label: "—", tone: "none" };
  return {
    label: `${r.verdict.recommendation.replace("_", " ")} ${r.verdict.confidence}`,
    tone: RECOMMENDATION_TONE[r.verdict.recommendation] ?? "none",
  };
}

/** What the run read, in the words the cockpit uses everywhere else. */
export function readMode(run: { withSource?: boolean | null; trusted?: boolean | null }): string {
  if (run.trusted) return "ran the code";
  return run.withSource ? "read the full source" : "read the diff only";
}

function commentsPart(r: ReviewListItem): string {
  if (r.commentCount === 0) return "no comments drafted";
  const drafted = `${r.commentCount} comment${r.commentCount === 1 ? "" : "s"} drafted`;
  return r.driftedCount ? `${drafted}, ${r.driftedCount} off-diff` : drafted;
}

/**
 * Why this row reads the way it does — the strip under the table. `meta` is the
 * quiet line under the reasoning; the view joins it with " · ".
 */
export function strip(
  r: ReviewListItem,
  daemon: DaemonStatus | null,
  now: number = Date.now(),
): { reasoning: string; meta: string[] } {
  if (r.status === "running") {
    return {
      reasoning: "Claude is reading the current head. This row updates itself when the run lands.",
      meta: [`started ${ageLabel(r.updatedAt, now)} ago`, readMode(r)],
    };
  }
  if (r.status === "awaiting") {
    return {
      reasoning:
        "Found by the inbox poll, not drafted yet — auto-review was off when it arrived, or it is still queued behind another run.",
      meta: ["no run yet", "press r to review now"],
    };
  }
  if (r.status === "failed") {
    return {
      reasoning: r.runError ?? "The review run failed before it produced a draft.",
      meta: ["press r to try again"],
    };
  }
  if (r.sent) {
    return {
      reasoning: `Sent to GitHub as ${EVENT_LABEL[r.sent.event] ?? r.sent.event} on ${new Date(
        r.sent.at,
      ).toLocaleDateString()}. Kept here as a record; the conversation can't continue.`,
      meta: [r.sent.auto ? "auto-sent by the daemon" : "sent by you", readMode(r)],
    };
  }

  const meta = [readMode(r)];
  if (r.costUsd != null) meta.push(`≈$${r.costUsd.toFixed(2)} at API rates`);
  meta.push(commentsPart(r));
  // Auto-send is approve-only, so the bar is only news on an approve verdict.
  if (daemon?.enabled && r.status === "ready" && r.verdict?.recommendation === "approve") {
    meta.push(
      r.verdict.confidence >= daemon.autoSendThreshold
        ? `auto-send candidate at ${r.verdict.confidence}%`
        : `below the ${daemon.autoSendThreshold}% auto-send bar`,
    );
  }
  return { reasoning: r.verdict?.reasoning ?? "This review has a draft but no verdict.", meta };
}
