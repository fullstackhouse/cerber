import { Artifact, artifactKey } from "../core/artifact.js";
import { evaluateAutoSend } from "../core/autosend.js";
import { searchAwaitingMe, submitReview } from "../core/gh.js";
import { buildReviewPayload, computeCalibration } from "../core/send.js";
import { appendAutoSendLog, updateArtifactByKey } from "../core/state.js";
import { pool, reviewPr } from "../runner/review.js";

export interface DaemonOptions {
  /** Repos to watch (owner/repo). Empty = everything your gh account can see. */
  repos: string[];
  intervalMs: number;
  parallel: number;
  model?: string;
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
  polls: number;
  errors: number;
  lastPollAt: string | null;
  nextPollAt: string | null;
  lastSummary: string | null;
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
 * Poll GitHub for PRs awaiting the user's review and keep their artifacts
 * warm. Reviews are read-only; the daemon NEVER sends anything.
 */
export function startDaemon(opts: DaemonOptions): DaemonHandle {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const status: DaemonStatus = {
    enabled: true,
    polling: false,
    repos: opts.repos,
    intervalMs: opts.intervalMs,
    polls: 0,
    errors: 0,
    lastPollAt: null,
    nextPollAt: new Date(Date.now()).toISOString(),
    lastSummary: null,
    autoSend: opts.autoSend,
    autoSendThreshold: opts.autoSendThreshold,
    autoSent: 0,
    autoSendCandidates: 0,
  };

  const log = (m: string) => console.log(`[daemon] ${m}`);

  async function poll(): Promise<void> {
    if (status.polling) return;
    status.polling = true;
    status.lastPollAt = new Date().toISOString();
    try {
      const filters = opts.repos.length > 0 ? opts.repos : [undefined];
      const seen = new Set<string>();
      const refs = (
        await Promise.all(filters.map((repo) => searchAwaitingMe(repo)))
      )
        .flat()
        .filter((r) => {
          const id = `${r.owner}/${r.repo}#${r.number}`;
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        });

      let reviewed = 0;
      let skipped = 0;
      let failed = 0;
      await pool(refs, opts.parallel, async (ref) => {
        const label = `${ref.owner}/${ref.repo}#${ref.number}`;
        try {
          const result = await reviewPr(ref, {
            model: opts.model,
            onProgress: (m) => log(`[${label}] ${m}`),
          });
          if (result.skipped) skipped++;
          else {
            reviewed++;
            await handleAutoSend(result.artifact);
          }
        } catch (err: unknown) {
          failed++;
          status.errors++;
          log(`[${label}] failed: ${err instanceof Error ? err.message : err}`);
        }
      });
      status.lastSummary = `${refs.length} awaiting; ${reviewed} reviewed, ${skipped} up to date${failed > 0 ? `, ${failed} failed` : ""}`;
      log(status.lastSummary);
    } catch (err: unknown) {
      status.errors++;
      status.lastSummary = `poll failed: ${err instanceof Error ? err.message : err}`;
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
