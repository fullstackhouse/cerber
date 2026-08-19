import { Artifact, SCHEMA_VERSION, artifactId, artifactKey } from "../core/artifact.js";
import { evaluateAutoSend } from "../core/autosend.js";
import { loadConfig } from "../core/config.js";
import { DiscoveredPr, fetchPrInfo, searchAwaitingMe, submitReview } from "../core/gh.js";
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
    calibration: null,
  };
}

/** An artifact nothing has touched yet — safe to delete when its PR leaves the queue. */
export function isPureStub(artifact: Artifact): boolean {
  return artifact.status === "awaiting" && artifact.comments.length === 0 && artifact.run === null;
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
      if (await loadArtifact(artifactId(ref))) continue;
      await saveArtifact(stubArtifact(ref));
      discovered++;
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
        if (pr.state !== "OPEN") {
          await updateArtifactByKey(artifactKey(artifact.id), (a) => ({
            ...a,
            pr: { ...a.pr, state: pr.state },
          }));
          log(`[${artifact.id}] ${pr.state.toLowerCase()} — archived`);
        }
      } catch {
        // Same: book-keeping can wait for the next poll.
      }
    }
    return { discovered };
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
      const config = await loadConfig().catch(() => null);
      const knobs = config?.daemon ?? { poll: true, autoReview: true };
      const autoReview = opts.autoReview && knobs.autoReview;
      status.pollEnabled = knobs.poll;
      status.autoReview = autoReview;
      // Recomputed too, so a trust rule added mid-run shows up in the strip.
      status.trustedRuns = autoReview && opts.trust !== false && (config?.trust.length ?? 0) > 0;

      if (!knobs.poll) {
        status.lastSummary = "polling off (settings) — the queue only shows what you review by hand";
        return;
      }

      const refs = await discover();
      status.lastPollError = null;
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
