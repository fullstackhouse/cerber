import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type { Artifact, Comment } from "./artifact.js";

/**
 * What happened to a review, and when — cerber's side of the story.
 *
 * An artifact keeps one `updatedAt`, so every write erases the answer to "when
 * did this become skipped?". This is the record that survives: one line per
 * thing that changed, appended by `saveArtifact` itself rather than by its
 * callers, so no write path can forget to keep it.
 *
 * It deliberately records only what cerber did and saw. GitHub keeps its own
 * timeline of pushes, requests and reviews, and `gh` can always be asked for it
 * again — mirroring it here would be a database wearing a different hat. The
 * one thing worth writing down is what the poll *saw* at a given minute, since
 * a search index cannot be asked what it said an hour ago.
 *
 * The chat is the other deliberate omission: a conversation already carries its
 * own turns, timestamps and revisions.
 */
export const HistoryActorSchema = z.enum(["daemon", "cockpit", "cli", "runner", "unknown"]);
export type HistoryActor = z.infer<typeof HistoryActorSchema>;

export const HistoryEntrySchema = z.object({
  at: z.string(),
  /** Which part of cerber wrote it. "unknown" when nothing claimed the write. */
  by: HistoryActorSchema.default("unknown"),
  /** What happened, in plain words: "status ready → skipped". */
  what: z.string(),
  /** What was being done at the time: "PATCH /api/reviews/…", "poll", "review". */
  cause: z.string().nullable().default(null),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

/**
 * How many entries one review keeps.
 *
 * Entries are ~100 bytes next to a diff that is routinely a hundred times
 * that, and a watchlist plus note de-duplication keeps a busy PR to a few
 * dozen — so this is a backstop against a pathological row, not a budget.
 */
export const MAX_ENTRIES = 500;

interface Writer {
  by: HistoryActor;
  cause: string | null;
}

/**
 * Who is writing right now.
 *
 * Ambient rather than a parameter on every write: there are twenty-odd call
 * sites and the useful answer is the same for all the writes one request, poll
 * or run makes. Set it once at each entry point — the HTTP middleware, the
 * poll, the CLI, an AI run — and every artifact write underneath is labelled,
 * including ones added later that never think about history at all. Nesting
 * works the obvious way: a run started by a request labels its own writes.
 */
const writer = new AsyncLocalStorage<Writer>();

export function withWriter<T>(w: { by: HistoryActor; cause?: string | null }, fn: () => T): T {
  return writer.run({ by: w.by, cause: w.cause ?? null }, fn);
}

export function currentWriter(): Writer {
  return writer.getStore() ?? { by: "unknown", cause: null };
}

const short = (sha: string) => (sha.length > 7 ? sha.slice(0, 7) : sha);

const FILED_PHRASE: Record<string, string> = {
  "own-review": "you had already reviewed it on GitHub",
  "own-reply": "you answered on the PR and nobody has answered back",
  "request-withdrawn": "nobody is asking for this review any more",
};

/** The shape of a run, said once at the top of it: what it could read, who asked. */
function runShape(run: NonNullable<Artifact["run"]>): string {
  const parts = [run.model ?? "default model", run.withSource ? "reading the source" : "diff only"];
  if (run.trusted) parts.push("trusted — may run commands");
  if (run.trigger) parts.push(run.trigger === "daemon" ? "asked for by the poll" : "asked for by you");
  return parts.join(", ");
}

/** Comment churn as one line: what a re-review, a chat turn or your own edits did. */
function describeComments(before: Comment[], after: Comment[]): string | null {
  const was = new Map(before.map((c) => [c.id, c]));
  const is = new Map(after.map((c) => [c.id, c]));
  let fromReview = 0;
  let yours = 0;
  let edited = 0;
  let regraded = 0;
  let dropped = 0;
  let restored = 0;
  for (const c of after) {
    const old = was.get(c.id);
    if (!old) {
      if (c.origin === "user") yours++;
      else fromReview++;
      continue;
    }
    if (old.body !== c.body) edited++;
    if (old.severity !== c.severity) regraded++;
    if (old.status !== "dropped" && c.status === "dropped") dropped++;
    if (old.status === "dropped" && c.status !== "dropped") restored++;
  }
  const gone = before.filter((c) => !is.has(c.id)).length;

  const parts: string[] = [];
  if (fromReview) parts.push(`+${fromReview} from the review`);
  if (yours) parts.push(`+${yours} you wrote`);
  if (edited) parts.push(`${edited} edited`);
  if (regraded) parts.push(`${regraded} re-graded`);
  if (dropped) parts.push(`${dropped} dropped`);
  if (restored) parts.push(`${restored} restored`);
  if (gone) parts.push(`${gone} gone`);
  return parts.length > 0 ? `comments: ${parts.join(", ")}` : null;
}

/**
 * What changed between two versions of a review, in plain words.
 *
 * A watchlist, not a deep diff. A generic comparison would bury the timeline
 * under a running turn's narration, which is rewritten to the artifact every
 * couple of seconds and says nothing about where the review got to.
 */
export function describeChange(before: Artifact | null, after: Artifact): string[] {
  const lines: string[] = [];

  if (!before) {
    lines.push(
      after.status === "awaiting"
        ? "appeared in the inbox — GitHub is asking you for a review"
        : `first written here (${after.status})`,
    );
  } else {
    if (before.status !== after.status) lines.push(`status ${before.status} → ${after.status}`);
    if (before.pr.headSha !== after.pr.headSha && after.pr.headSha) {
      lines.push(
        before.pr.headSha
          ? `head moved ${short(before.pr.headSha)} → ${short(after.pr.headSha)}`
          : `head is ${short(after.pr.headSha)}`,
      );
    }
    if (before.pr.state !== after.pr.state) {
      lines.push(after.pr.state === "OPEN" ? "PR reopened" : `PR ${after.pr.state.toLowerCase()}`);
    }
    if (before.pr.isDraft !== after.pr.isDraft) {
      lines.push(after.pr.isDraft ? "turned back into a draft" : "marked ready for review");
    }
  }

  const wasRun = before?.run ?? null;
  const run = after.run;
  if (run && run.startedAt !== wasRun?.startedAt) lines.push(`review started (${runShape(run)})`);
  if (run?.finishedAt && run.finishedAt !== wasRun?.finishedAt && !run.error) {
    lines.push(
      `review finished${run.reviewedSha ? ` at ${short(run.reviewedSha)}` : ""}` +
        `${run.costUsd != null ? ` (≈$${run.costUsd.toFixed(2)} at API rates)` : ""}`,
    );
  }
  if (run?.error && run.error !== wasRun?.error) lines.push(`review failed: ${run.error}`);

  const wasVerdict = before?.verdict ?? null;
  const verdict = after.verdict;
  if (
    verdict &&
    (!wasVerdict ||
      wasVerdict.recommendation !== verdict.recommendation ||
      wasVerdict.confidence !== verdict.confidence)
  ) {
    lines.push(
      `verdict ${wasVerdict ? "changed to" : "set to"} ${verdict.recommendation.replace("_", " ")}` +
        ` (${verdict.confidence}% sure of the findings)`,
    );
  }

  const comments = describeComments(before?.comments ?? [], after.comments);
  if (comments) lines.push(comments);

  if (after.sent && after.sent.at !== before?.sent?.at) {
    lines.push(
      `sent to GitHub as ${after.sent.event.toLowerCase().replace("_", " ")}` +
        `${after.sent.auto ? ", by auto-send" : ""}`,
    );
  }
  if (after.filed && after.filed.at !== before?.filed?.at) {
    lines.push(`filed under settled — ${FILED_PHRASE[after.filed.reason] ?? after.filed.reason}`);
  }
  if (after.refresh && after.refresh.at !== before?.refresh?.at) {
    const r = after.refresh;
    lines.push(
      `pulled forward onto ${short(r.toSha)} — ${r.moved} comment(s) followed the code` +
        `${r.drifted > 0 ? `, ${r.drifted} drifted` : ""}`,
    );
  }

  return lines;
}

/**
 * The history to write, given what is on disk and what is about to replace it.
 *
 * Whatever history the caller is holding is ignored: several write paths
 * legitimately hand over an artifact built minutes ago, and their copy of the
 * log is stale by definition. Disk is the only source.
 */
export function appendHistory(
  prior: Artifact | null,
  next: Artifact,
  opts: { note?: string; unreadable?: boolean } = {},
): HistoryEntry[] {
  const kept = prior?.history ?? [];
  const { by, cause } = currentWriter();
  const at = new Date().toISOString();

  const what = opts.unreadable
    ? ["history restarts here — the previous file could not be read"]
    : opts.note
      ? // A note explains a decision the poll re-takes every few minutes. Said
        // once: repeating it until something else happens is noise, and the
        // entry it would duplicate already says the same thing.
        kept.at(-1)?.what === opts.note
        ? []
        : [opts.note]
      : describeChange(prior, next);

  const all = [...kept, ...what.map((w) => ({ at, by, cause, what: w }))];
  if (all.length <= MAX_ENTRIES) return all;
  const [oldest, ...rest] = all.slice(-(MAX_ENTRIES - 1));
  if (!oldest) return all;
  return [
    { at: oldest.at, by: "unknown" as const, cause: null, what: "… earlier entries dropped" },
    oldest,
    ...rest,
  ];
}
