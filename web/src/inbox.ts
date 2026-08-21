// What the queue knows about a review before you open it.
//
// The cursor row explains itself in the strip under the table — verdict
// reasoning, what the run read, why it is or isn't an auto-send candidate — so
// walking the queue doesn't mean opening every review. These derivations are
// shared with the detail view, whose ‹ › arrows walk the very same list.

import { DaemonStatus, Reply, ReviewListItem } from "./types";

export type Tab = "inbox" | "awaiting" | "drafted" | "requests" | "settled" | "sent" | "archived";

/**
 * One filter row, one list. Every bucket the queue can show is a tab: the work
 * still waiting on you first, then what you already dealt with. Two mechanisms
 * — tabs over the live rows and accordions over the rest — meant "all 2" sat
 * above a drawer holding twelve more, and neither strip told you the other
 * existed.
 */
export const INBOX_TABS: Tab[] = ["inbox", "awaiting", "drafted"];

/** The quieter half of the row: work that is done, or done here at least. */
export const FILED_TABS: Tab[] = ["requests", "settled", "sent", "archived"];

/** What each tab is called, and what it holds. The title is the whole answer. */
export const TAB_META: Record<Tab, { label: string; title: string }> = {
  inbox: {
    label: "inbox",
    title: "Everything still waiting on you — drafted reviews and PRs the poll found but nobody has read.",
  },
  awaiting: {
    label: "awaiting",
    title: "Found by the inbox poll, not drafted yet — or a run is in flight right now.",
  },
  drafted: { label: "drafted", title: "A draft is written and waiting for you to read it." },
  requests: {
    label: "open requests",
    title:
      "GitHub still lists you as a requested reviewer on these. You settled or archived them here without submitting a review, so they also appear under whichever tab you filed them in.",
  },
  settled: {
    label: "settled",
    title: "You marked these reviewed or skipped. Nothing was sent to GitHub.",
  },
  sent: { label: "sent", title: "Reviews that reached GitHub. Kept here as a record." },
  archived: { label: "archived", title: "PRs that have since been merged or closed." },
};

/**
 * Which tab a review's status puts it in. Every status lands in exactly one —
 * including `sent`, which `bucket` never asks about because a sent review is
 * out of the live list before it gets here.
 */
export function tabOf(r: ReviewListItem): "awaiting" | "drafted" | "sent" {
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
export const SETTLED = ["sent", "reviewed", "skipped"];

/**
 * The reviews the ‹ › arrows walk: open PRs that still want something from you.
 * A sent review is a record and a skipped one is a decision, so walking past
 * either would be walking backwards.
 */
export function walkable(list: ReviewListItem[]): ReviewListItem[] {
  return sortReviews(list.filter((r) => !isArchived(r) && !SETTLED.includes(r.status)));
}

/**
 * The reviews GitHub still wants from you that the queue is not showing.
 *
 * The queue lists what you have not dealt with locally; the daemon reports what
 * GitHub still asks you for. Those two stop matching the moment you skip a PR
 * or mark one reviewed without sending — cerber never writes to GitHub, so the
 * review request outlives your decision here. That is the state where the
 * cockpit used to say "nothing awaits your review" over the top of a poll that
 * had just counted two, and the work went missing.
 */
export function hiddenAwaiting(list: ReviewListItem[], daemon: DaemonStatus | null): ReviewListItem[] {
  if (!daemon?.enabled || daemon.awaiting.length === 0) return [];
  const shown = new Set(walkable(list).map((r) => r.id));
  const awaiting = new Set(daemon.awaiting.map((a) => a.id));
  return sortReviews(list.filter((r) => awaiting.has(r.id) && !shown.has(r.id)));
}

/** True when GitHub has no review from you on this row, but the queue filed it away. */
export const isHiddenAwaiting = (r: ReviewListItem, hidden: ReviewListItem[]) =>
  hidden.some((h) => h.id === r.id);

/**
 * Every tab's rows, worked out once. The queue reads its list and its counts
 * from the same object, so a tab can never claim a number the table then
 * disagrees with. `requests` deliberately overlaps the tabs after it: it is a
 * question about GitHub, not a fourth place a review can be filed.
 */
export function bucket(all: ReviewListItem[], daemon: DaemonStatus | null): Record<Tab, ReviewListItem[]> {
  const open = all.filter((r) => !isArchived(r));
  const live = sortReviews(open.filter((r) => !SETTLED.includes(r.status)));
  return {
    inbox: live,
    awaiting: live.filter((r) => tabOf(r) === "awaiting"),
    drafted: live.filter((r) => tabOf(r) === "drafted"),
    requests: hiddenAwaiting(all, daemon),
    settled: sortReviews(open.filter((r) => r.status === "reviewed" || r.status === "skipped")),
    sent: sortReviews(open.filter((r) => r.status === "sent")),
    archived: sortReviews(all.filter(isArchived)),
  };
}

/**
 * The tab actually on screen. A filed tab is only in the row while it holds
 * something, so the one you are standing on can empty under you — you settle
 * its last review, or a poll answers the last open request. Fall back to the
 * inbox rather than leaving you on a tab that is no longer in the row: what
 * left the tab you were reading went back to the queue, which is where you
 * now are.
 */
export function shownTab(picked: Tab, buckets: Record<Tab, ReviewListItem[]>): Tab {
  return FILED_TABS.includes(picked) && buckets[picked].length === 0 ? "inbox" : picked;
}

/**
 * What happened to this row, when the verdict column doesn't already say it:
 * your own decision, or GitHub's. A sent review says "sent · approve" in the
 * verdict column, so a tag there would only repeat it.
 */
export function rowTag(r: ReviewListItem): string | null {
  if (isArchived(r)) return r.pr.state?.toLowerCase() ?? null;
  if (r.status === "reviewed" || r.status === "skipped") return r.status;
  return null;
}

/** Whose move it is on this row, as the last poll left it. */
export function replyOf(r: ReviewListItem, daemon: DaemonStatus | null): Reply {
  if (!daemon?.enabled) return "unknown";
  return daemon.awaiting.find((a) => a.id === r.id)?.reply ?? "unknown";
}

/**
 * The tag on a row GitHub still holds a request for. The request alone only
 * says you never pressed GitHub's review button; the conversation says whether
 * that leaves anyone waiting, which is the part you decide on. When the
 * conversation could not be read, it falls back to the fact we do have.
 */
const REPLY_TAG: Record<Reply, { label: string; title: string }> = {
  none: {
    label: "you haven't replied",
    title:
      "GitHub still lists you as a requested reviewer and you have said nothing on the PR — no review, no comment. Whoever opened it is waiting on you.",
  },
  you: {
    label: "waiting on them",
    title:
      "You had the last word in the conversation but never submitted a review, so GitHub still lists you as a requested reviewer. Nothing is blocked on you until they answer.",
  },
  them: {
    label: "they replied last",
    title:
      "You commented and someone has answered since, so the conversation is back with you — and GitHub still lists you as a requested reviewer, because a comment is not a review.",
  },
  unknown: {
    label: "unanswered on GitHub",
    title:
      "You have never submitted a review on GitHub for this PR, so it still lists you as a requested reviewer. Cerber could not read the conversation, so it can't say whether you replied there.",
  },
};

export const replyTag = (reply: Reply) => REPLY_TAG[reply];

/**
 * The tag on an open-requests row, from the best thing cerber knows.
 *
 * Its own send record beats the poll's read of the conversation, because the
 * read cannot see a review at all: `classifyReply` works off the PR's issue
 * comments, where a submitted review — body, inline comments and all — leaves
 * nothing. So a row cerber sent minutes ago came back tagged "you haven't
 * replied", beside a verdict column reading "sent · approve". Two claims about
 * one row, and the wrong one was the louder.
 *
 * A poll runs every few minutes, so a request outliving a send usually just
 * means the search answered before the send. Whether GitHub also keeps the
 * request open for a comment-only review is its business — either way, the
 * fact worth stating is the one cerber is sure of: your review went.
 */
export function sentTag(sent: NonNullable<ReviewListItem["sent"]>): { label: string; title: string } {
  const event = EVENT_LABEL[sent.event] ?? sent.event;
  const when = new Date(sent.at).toLocaleDateString();
  return {
    label: sent.auto ? "auto-sent a review" : "you replied with a review",
    // Never "you" for an auto-send: the daemon sent it under a bar you set,
    // which is not the same as you having answered the PR.
    //
    // Two facts and no theory about which one explains the other. A poll that
    // answered before the send is the likely reason the request is still
    // listed, but nothing here knows the order, and GitHub keeps some requests
    // open regardless — naming a cause we haven't checked is the same
    // over-claiming the tag itself was fixed for.
    title:
      `${sent.auto ? "The daemon auto-sent this review" : "You sent this review"} to GitHub on ` +
      `${when} as ${event}. The last inbox poll still listed a review request for you — a request ` +
      `can lag a send, and GitHub holds some open even after one.`,
  };
}

/** The open-requests tag for a row: what cerber sent, or whose move the poll says it is. */
export const requestTag = (r: ReviewListItem, reply: Reply) =>
  r.sent ? sentTag(r.sent) : replyTag(reply);

/**
 * What to say instead of "nothing awaits your review" when something does.
 *
 * Says what it actually knows — GitHub holds a review request you never
 * answered — rather than telling you what you owe. Settling is a decision you
 * made and it stands; this only reports the half of it GitHub never heard.
 */
export function hiddenAwaitingNote(hidden: ReviewListItem[]): string {
  const n = hidden.length;
  const requests = n === 1 ? "1 review request" : `${n} review requests`;
  // A row can also be hidden because cerber has it archived while GitHub still
  // lists the PR as open — its cached state is behind, and "settled" would be
  // the wrong word for it.
  const how = hidden.some(isArchived) ? "settled or archived" : "settled";
  return (
    `Nothing new in the inbox — but GitHub still has ${requests} open on you. ` +
    `You ${how} ${n === 1 ? "it" : "them"} here without submitting a review, ` +
    `so ${n === 1 ? "it is" : "they are"} under open requests, tagged with whose move it is.`
  );
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
  // This column is one of the narrowest on the row, and spelling the blocker
  // count out here truncated it to "approve · no bloc…". The count moves to the
  // strip below, which has room; the cell keeps the verdict and how sure the
  // review is of itself.
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
  const parts = [`${r.commentCount} comment${r.commentCount === 1 ? "" : "s"} drafted`];
  if (r.driftedCount) parts.push(`${r.driftedCount} off-diff`);
  // Only blockers block, so of all the grades this is the one the strip names.
  if (r.gradedCount) {
    parts.push(
      r.blockerCount ? `${r.blockerCount} blocker${r.blockerCount === 1 ? "" : "s"}` : "no blockers",
    );
  }
  return parts.join(", ");
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
  // What you did with it, when that isn't "nothing yet".
  if (r.status === "reviewed") meta.unshift("you marked this reviewed");
  if (r.status === "skipped") meta.unshift("you skipped this");
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
