import { Artifact, SCHEMA_VERSION, artifactId, artifactKey } from "../core/artifact.js";
import { evaluateAutoSend } from "../core/autosend.js";
import { loadConfig } from "../core/config.js";
import {
  DiscoveredPr,
  OwnReview,
  Reply,
  classifyReply,
  currentLogin,
  fetchConversation,
  fetchOwnReview,
  fetchPrInfo,
  searchAwaitingMe,
  submitReview,
} from "../core/gh.js";
import { buildReviewPayload, computeCalibration } from "../core/send.js";
import {
  appendAutoSendLog,
  deleteArtifact,
  listArtifacts,
  loadArtifact,
  saveArtifact,
  updateArtifactByKey,
} from "../core/state.js";
import { ReviewInProgressError } from "../runner/inflight.js";
import { pool, reviewPr } from "../runner/review.js";

export interface DaemonOptions {
  /** Repos to watch (owner/repo). Empty = everything your gh account can see. */
  repos: string[];
  intervalMs: number;
  parallel: number;
  model?: string;
  /** False reviews the diff alone, with no local checkout. Defaults to on. */
  withSource?: boolean;
  /** Overrides the configured trust rules for every run; undefined defers to them. */
  trust?: boolean;
  /**
   * Draft an AI review for whatever lands in the queue. False discovers only:
   * awaiting rows appear, and the human clicks review when they want a draft.
   * This is the per-run cap (--no-auto-review); the config's daemon.autoReview
   * is consulted live on every poll, so the cockpit toggle needs no restart.
   */
  autoReview: boolean;
  /**
   * "shadow" (default): log what WOULD be auto-sent, send nothing.
   * "on": actually auto-send APPROVE verdicts at/above the threshold —
   * the user opted in explicitly via --auto-send.
   */
  autoSend: "shadow" | "on";
  autoSendThreshold: number;
}

/**
 * A PR awaiting your review, and whose move it is on it. The request alone
 * doesn't say: you may have argued the whole thing out in the conversation
 * without ever pressing GitHub's review button, which leaves the request open
 * and the ball in the author's court.
 */
export interface AwaitingPr {
  id: string;
  reply: Reply;
}

export interface DaemonStatus {
  enabled: true;
  polling: boolean;
  repos: string[];
  intervalMs: number;
  /** False when the config's daemon.poll toggle idles the loop. */
  pollEnabled: boolean;
  autoReview: boolean;
  /** Unattended reviews may run PR code: auto-review on, trust rules present. */
  trustedRuns: boolean;
  polls: number;
  errors: number;
  lastPollAt: string | null;
  nextPollAt: string | null;
  lastSummary: string | null;
  /**
   * The PRs GitHub still holds a review request from you on, from the last poll
   * that reached it. The cockpit filters its queue on what you have dealt with
   * locally, which stops matching this the moment you skip a PR or mark one
   * reviewed without sending — so it needs this list to say what it is hiding.
   * Empty while polling is off: discovery you turned off makes no claim.
   */
  awaiting: AwaitingPr[];
  /** Set while GitHub discovery is failing (gh unauthed, offline) — the queue still works. */
  lastPollError: string | null;
  autoSend: "shadow" | "on";
  autoSendThreshold: number;
  autoSent: number;
  autoSendCandidates: number;
}

export interface DaemonHandle {
  status: () => DaemonStatus;
  stop: () => void;
}

/**
 * A pure discovery stub: enough artifact for the queue to show an awaiting row.
 * The AI run that follows (automatic or clicked) replaces it wholesale.
 */
export function stubArtifact(ref: DiscoveredPr): Artifact {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: artifactId(ref),
    status: "awaiting",
    createdAt: now,
    updatedAt: now,
    pr: {
      owner: ref.owner,
      repo: ref.repo,
      number: ref.number,
      title: ref.title,
      url: ref.url,
      author: ref.author,
      body: "",
      baseRefName: "",
      headRefName: "",
      headSha: "",
      state: "OPEN",
      isDraft: ref.isDraft,
      additions: 0,
      deletions: 0,
      changedFiles: 0,
    },
    diff: "",
    summary: "",
    chapters: [],
    comments: [],
    verdict: null,
    run: null,
    sent: null,
    refresh: null,
    filed: null,
    calibration: null,
    chat: [],
    preChat: null,
    pendingChat: null,
  };
}

/**
 * An artifact nothing has touched yet — safe to delete when its PR leaves the
 * queue.
 *
 * Read this before loosening it. Artifacts now arrive two ways: the daemon
 * discovers them, and the user pastes a PR into the cockpit. The reaper below
 * deletes anything absent from the awaiting search, which is only ever correct
 * for the first kind — a pasted PR was never in that search and never will be.
 * What keeps it safe is `run === null`: the cockpit's create endpoint persists
 * a run block before it answers, so a pulled-in review is never a pure stub,
 * not even during the minutes before its first AI output lands. Widen this
 * predicate and you delete work the user asked for.
 */
export function isPureStub(artifact: Artifact): boolean {
  return artifact.status === "awaiting" && artifact.comments.length === 0 && artifact.run === null;
}

/**
 * Whether a review of yours on GitHub settles this draft.
 *
 * Two facts have to hold. GitHub must have stopped asking you — the caller has
 * already established that, since this only runs on artifacts absent from the
 * awaiting search — and you must have submitted a review of your own, which is
 * the half cerber could not see before: a review clears the request whether it
 * went through Send or through GitHub's own button, and only the first left a
 * trace here. Together they mean the PR is back with its author, while the
 * inbox went on listing the draft as work still waiting on you.
 *
 * The trigger test is what keeps this from undoing a deliberate act. A draft
 * you asked for — pasted the URL in, pressed re-review — after you had already
 * reviewed the PR is a second opinion you went and requested, so filing it
 * away would answer a question you had just posed. A draft the poll wrote on
 * its own carries no such intent: it is exactly the row this is here to close.
 */
export function filedByOwnReview(artifact: Artifact, review: OwnReview | null): boolean {
  if (artifact.status !== "ready" || artifact.sent || !review) return false;
  const run = artifact.run;
  return !(run?.trigger === "user" && run.startedAt >= review.at);
}

/** How many open-PR artifacts to re-check against GitHub per poll, and how often each. */
const STATE_REFRESH_CAP = 10;
const STATE_REFRESH_MIN_MS = 30 * 60_000;

/**
 * The inbox loop behind `cerber serve`: poll GitHub for PRs awaiting the
 * user's review, list them as `awaiting`, and (unless auto-review is off)
 * draft a review for each. Merged/closed PRs are archived out of the queue.
 * Reviews stay local; the daemon NEVER sends anything except via the
 * explicitly opted-in auto-send path.
 */
export function startDaemon(opts: DaemonOptions): DaemonHandle {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const status: DaemonStatus = {
    enabled: true,
    polling: false,
    repos: opts.repos,
    intervalMs: opts.intervalMs,
    pollEnabled: true,
    autoReview: opts.autoReview,
    trustedRuns: false,
    polls: 0,
    errors: 0,
    lastPollAt: null,
    nextPollAt: new Date(Date.now()).toISOString(),
    lastSummary: null,
    awaiting: [],
    lastPollError: null,
    autoSend: opts.autoSend,
    autoSendThreshold: opts.autoSendThreshold,
    autoSent: 0,
    autoSendCandidates: 0,
  };

  const log = (m: string) => console.log(`[daemon] ${m}`);
  /** When GitHub last confirmed an artifact's PR state, by artifact id. In-memory:
   *  a restart just re-checks sooner, which is harmless. */
  const stateCheckedAt = new Map<string, number>();

  async function discover(): Promise<DiscoveredPr[]> {
    const filters = opts.repos.length > 0 ? opts.repos : [undefined];
    const seen = new Set<string>();
    return (await Promise.all(filters.map((repo) => searchAwaitingMe(repo))))
      .flat()
      .filter((r) => {
        const id = artifactId(r);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
  }

  /**
   * Make the local queue mirror what's actually awaiting: stub artifacts for
   * newly discovered PRs, archive merged/closed ones, drop stubs whose review
   * request went away. Freshness decisions always come from local artifacts —
   * search results lag GitHub by minutes and never override them.
   */
  async function syncQueue(refs: DiscoveredPr[]): Promise<{ discovered: number }> {
    let discovered = 0;
    for (const ref of refs) {
      const existing = await loadArtifact(artifactId(ref));
      if (existing) {
        // The search result is what the PR is right now; the artifact can
        // predate a draft→ready flip. Refresh from it — it costs nothing, it's
        // already in hand — or the queue keeps calling a ready PR a draft until
        // something happens to re-review it.
        if (existing.pr.isDraft !== ref.isDraft) {
          await updateArtifactByKey(artifactKey(existing.id), (a) => ({
            ...a,
            pr: { ...a.pr, isDraft: ref.isDraft },
          }));
        }
        continue;
      }
      await saveArtifact(stubArtifact(ref));
      discovered++;
    }

    // Asked once per pass, and only if a row actually reaches the check that
    // needs it. Undefined is "not asked yet"; null is "gh could not say", which
    // attributes nothing to you rather than guessing.
    let login: string | null | undefined;

    /**
     * File a draft away once GitHub says you already reviewed the PR yourself.
     *
     * The queue lists what you have not dealt with locally, and a review
     * submitted on github.com never reached it — so a PR you answered days ago
     * sat in the inbox as if it still wanted you. This is the one read that
     * closes that gap, on the same 30-minute-per-artifact leash as the state
     * check it rides along with.
     */
    async function fileIfYouReviewedItYourself(artifact: Artifact): Promise<void> {
      // Only a finished, unsent draft can be filed — checked here too, so a row
      // that could never qualify costs no GitHub call at all.
      if (artifact.status !== "ready" || artifact.sent) return;
      if (login === undefined) login = await currentLogin().catch(() => null);
      if (login === null) return;
      const review = await fetchOwnReview(artifact.pr, login);
      if (!review || !filedByOwnReview(artifact, review)) return;
      const filed = { at: new Date().toISOString(), review };
      const saved = await updateArtifactByKey(artifactKey(artifact.id), (a) =>
        // Re-read from disk: a run or a send may have started in the seconds
        // this read took, and neither wants filing out from under it.
        filedByOwnReview(a, review) ? { ...a, status: "reviewed" as const, filed } : a,
      );
      if (saved?.filed) {
        log(`[${artifact.id}] you reviewed this on GitHub on ${review.at.slice(0, 10)} — filed as reviewed`);
      }
    }

    const awaitingIds = new Set(refs.map((r) => artifactId(r)));
    let refreshed = 0;
    for (const artifact of await listArtifacts()) {
      if (artifact.status === "running") continue;
      if (awaitingIds.has(artifact.id)) continue;
      if (artifact.pr.state !== "OPEN") continue;

      if (isPureStub(artifact)) {
        // Discovered earlier, gone from the search now: merged/closed (archive
        // it), or the request was withdrawn / handled elsewhere (drop it — it
        // holds no work, and search lag at worst re-creates it next poll).
        try {
          const pr = await fetchPrInfo(artifact.pr);
          if (pr.state !== "OPEN") {
            await updateArtifactByKey(artifactKey(artifact.id), (a) => ({ ...a, pr }));
            log(`[${artifact.id}] ${pr.state.toLowerCase()} — archived`);
          } else {
            await deleteArtifact(artifact.id);
            log(`[${artifact.id}] no longer awaiting your review — removed from the queue`);
          }
        } catch {
          // GitHub unreachable — leave the stub; next poll retries.
        }
        continue;
      }

      // Anything with real work in it: periodically confirm the PR is still
      // open, so merged/closed ones stop cluttering the queue. Capped and
      // spaced out — this is book-keeping, not a data feed.
      if (refreshed >= STATE_REFRESH_CAP) continue;
      const last = stateCheckedAt.get(artifact.id) ?? 0;
      if (Date.now() - last < STATE_REFRESH_MIN_MS) continue;
      refreshed++;
      stateCheckedAt.set(artifact.id, Date.now());
      try {
        const pr = await fetchPrInfo(artifact.pr);
        // This artifact isn't in the awaiting search, so the cheap draft refresh
        // above never sees it — a PR pulled in from the cockpit's paste box gets
        // its draft flag corrected here instead. Same fetch either way.
        if (pr.state !== "OPEN" || pr.isDraft !== artifact.pr.isDraft) {
          await updateArtifactByKey(artifactKey(artifact.id), (a) => ({
            ...a,
            pr: { ...a.pr, state: pr.state, isDraft: pr.isDraft },
          }));
        }
        if (pr.state !== "OPEN") log(`[${artifact.id}] ${pr.state.toLowerCase()} — archived`);
        else await fileIfYouReviewedItYourself(artifact);
      } catch {
        // Same: book-keeping can wait for the next poll.
      }
    }
    return { discovered };
  }

  /**
   * Whose move it is on each awaiting PR, one conversation read apiece.
   *
   * GitHub's `commenter:` search qualifier would answer this in a single call,
   * but it demonstrably disagrees with the REST API — it misses PRs whose only
   * comment is the newest thing on them — and a tag that says "you never
   * replied" to someone who did is the exact bug this whole change fixes. So
   * the conversation is read per PR, bounded by the review concurrency. A read
   * that fails yields `unknown`, which claims nothing.
   */
  async function classifyAll(refs: DiscoveredPr[]): Promise<AwaitingPr[]> {
    let login: string;
    try {
      login = await currentLogin();
    } catch {
      // Without knowing who you are, no comment can be attributed to you.
      return refs.map((ref) => ({ id: artifactId(ref), reply: "unknown" as const }));
    }
    return pool(refs, opts.parallel, async (ref) => {
      try {
        return { id: artifactId(ref), reply: classifyReply(await fetchConversation(ref), login) };
      } catch {
        return { id: artifactId(ref), reply: "unknown" as const };
      }
    });
  }

  async function reviewAll(refs: DiscoveredPr[]): Promise<{ reviewed: number; skipped: number; failed: number }> {
    let reviewed = 0;
    let skipped = 0;
    let failed = 0;
    await pool(refs, opts.parallel, async (ref) => {
      const label = artifactId(ref);
      try {
        const result = await reviewPr(ref, {
          model: opts.model,
          trigger: "daemon",
          withSource: opts.withSource,
          trust: opts.trust,
          onProgress: (m) => log(`[${label}] ${m}`),
        });
        if (result.skipped) skipped++;
        else {
          reviewed++;
          await handleAutoSend(result.artifact);
        }
      } catch (err: unknown) {
        if (err instanceof ReviewInProgressError) {
          // The cockpit (or an earlier, slower poll) is already on it.
          skipped++;
          return;
        }
        failed++;
        status.errors++;
        log(`[${label}] failed: ${err instanceof Error ? err.message : err}`);
      }
    });
    return { reviewed, skipped, failed };
  }

  async function poll(): Promise<void> {
    if (status.polling) return;
    status.polling = true;
    status.lastPollAt = new Date().toISOString();
    try {
      // The config is re-read every poll, so the cockpit's Settings toggles
      // take effect on the next tick — no restart. CLI --no-* flags cap it.
      // loadConfig is strict on purpose (a typo must not silently change trust
      // or the knobs), so a broken file skips the tick loudly instead of
      // proceeding on guessed defaults.
      const config = await loadConfig();
      const knobs = config.daemon;
      const autoReview = opts.autoReview && knobs.autoReview;
      status.pollEnabled = knobs.poll;
      status.autoReview = autoReview;
      // Recomputed too, so a trust rule added mid-run shows up in the strip.
      status.trustedRuns = autoReview && opts.trust !== false && config.trust.length > 0;

      if (!knobs.poll) {
        // Deliberately off is not an outage — don't leave a stale error up, or
        // a list of PRs we are no longer checking are still awaiting you.
        status.lastPollError = null;
        status.awaiting = [];
        status.lastSummary = "polling off (settings) — the queue only shows what you review by hand";
        return;
      }

      const refs = await discover();
      status.lastPollError = null;
      // The same refs behind lastSummary's count, so the number the strip shows
      // and the rows the cockpit can name always come from one answer.
      // A failed poll leaves the last good list up; lastPollError says so.
      status.awaiting = await classifyAll(refs);
      const { discovered } = await syncQueue(refs);

      if (autoReview) {
        const { reviewed, skipped, failed } = await reviewAll(refs);
        status.lastSummary =
          `${refs.length} awaiting; ${reviewed} reviewed, ${skipped} up to date` +
          `${failed > 0 ? `, ${failed} failed` : ""}`;
      } else {
        status.lastSummary = `${refs.length} awaiting${discovered > 0 ? `, ${discovered} new` : ""} (auto-review off)`;
      }
      log(status.lastSummary);
    } catch (err: unknown) {
      status.errors++;
      status.lastPollError = err instanceof Error ? err.message : String(err);
      status.lastSummary = `poll failed: ${status.lastPollError}`;
      log(status.lastSummary);
    } finally {
      status.polls++;
      status.polling = false;
      if (!stopped) {
        status.nextPollAt = new Date(Date.now() + opts.intervalMs).toISOString();
        timer = setTimeout(poll, opts.intervalMs);
      }
    }
  }

  async function handleAutoSend(artifact: Artifact): Promise<void> {
    const decision = evaluateAutoSend(artifact, opts.autoSendThreshold);
    if (decision.eligible) status.autoSendCandidates++;
    const entryBase = {
      at: new Date().toISOString(),
      id: artifact.id,
      recommendation: artifact.verdict?.recommendation ?? null,
      confidence: artifact.verdict?.confidence ?? null,
      mode: opts.autoSend,
    };

    if (!decision.eligible) {
      await appendAutoSendLog({ ...entryBase, decision: decision.reason, sent: false });
      return;
    }

    if (opts.autoSend === "shadow") {
      log(`[${artifact.id}] WOULD auto-send: ${decision.reason} (shadow mode — nothing sent)`);
      await appendAutoSendLog({ ...entryBase, decision: `would send: ${decision.reason}`, sent: false });
      return;
    }

    try {
      const payload = buildReviewPayload(artifact, "APPROVE");
      const { url } = await submitReview(
        { owner: artifact.pr.owner, repo: artifact.pr.repo, number: artifact.pr.number },
        { event: payload.event, body: payload.body, comments: payload.comments, commitId: payload.commitId },
      );
      await updateArtifactByKey(artifactKey(artifact.id), (a) => ({
        ...a,
        status: "sent" as const,
        sent: { at: new Date().toISOString(), event: "APPROVE" as const, url, auto: true },
        calibration: computeCalibration(a, "APPROVE"),
      }));
      status.autoSent++;
      log(`[${artifact.id}] AUTO-SENT approve (${decision.reason})${url ? ` — ${url}` : ""}`);
      await appendAutoSendLog({ ...entryBase, decision: `auto-sent: ${decision.reason}`, sent: true });
    } catch (err: unknown) {
      status.errors++;
      const message = err instanceof Error ? err.message : String(err);
      log(`[${artifact.id}] auto-send failed: ${message}`);
      await appendAutoSendLog({ ...entryBase, decision: `auto-send failed: ${message}`, sent: false });
    }
  }

  void poll();

  return {
    status: () => ({ ...status }),
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
